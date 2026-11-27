import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiClient, PatchFilesBody } from './api-client.js';
import type { CloudContext } from './cloud-context.js';
import { MANIFEST_FILENAME } from './constants.js';
import { UsageError } from './exit-codes.js';
import {
	isAcceptedProjectPath,
	projectFileEncoding,
	toProjectFileEntries,
} from './project-files.js';
import { computeDelta, hashContent, syncWithRetry } from './sync-engine.js';

export const IGNORED_DIRECTORY_NAMES = new Set(['node_modules', '.git', 'output', 'dist', '.poli']);

/**
 * `true` when a segment of `relPath` names a directory the sync never
 * enters. The watcher prunes directories with it: `shouldIgnoreProjectPath`
 * is a file check and rejects `templates/`, `partials/` and `assets/`
 * themselves, so it cannot decide which directories to walk.
 */
export function isInIgnoredProjectDirectory(relPath: string): boolean {
	return relPath.split(/[\\/]/).some((segment) => IGNORED_DIRECTORY_NAMES.has(segment));
}

export function shouldIgnoreProjectPath(relPath: string): boolean {
	// Callers pass the raw output of `relative()`, which is
	// backslash-separated on Windows. Normalise here, at the public
	// boundary, so every rule below sees POSIX segments on every host:
	// `templates\\inv\\inv.html` is in the file set, and
	// `templates\\inv\\node_modules\\x.json` is not.
	const normalized = relPath.split(/[\\/]/).join('/');
	if (isInIgnoredProjectDirectory(normalized)) return true;
	if (normalized.endsWith('.DS_Store')) return true;
	if (normalized.endsWith('.log')) return true;
	return !isAcceptedProjectPath(normalized);
}

/**
 * The API's limits on a project (poli-page/poli-page#1251, the publish
 * route): at most 1000 files; a publish body of at most 5 MiB, which the
 * raw bytes of its files never exceed once encoded; and a bundle holding at
 * most 4 MiB of assets, so one bigger file can never be served back.
 */
export const PROJECT_MAX_FILES = 1000;
export const PROJECT_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const PROJECT_FILE_MAX_BYTES = 4 * 1024 * 1024;

/** The only paths of a project that can hold a file of the file set. */
const PROJECT_ROOT_FILES = [MANIFEST_FILENAME, 'tailwind.css'];
const PROJECT_ROOT_DIRECTORIES = ['templates', 'partials', 'assets'];

export interface ProjectFileStat {
	/** Project-relative POSIX path, as sent on the wire. */
	path: string;
	size: number;
}

function mebibytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function tooLarge(path: string, size: number): UsageError {
	return new UsageError(
		`${path} is ${mebibytes(size)}; a project file may be at most ${mebibytes(PROJECT_FILE_MAX_BYTES)}. Shrink it or move it out of the project.`
	);
}

function tooManyBytes(path: string): UsageError {
	return new UsageError(
		`The project files add up to more than ${mebibytes(PROJECT_MAX_TOTAL_BYTES)} (at ${path}), the most a publish may carry. Shrink or remove large assets.`
	);
}

async function lstatIfExists(path: string): Promise<Stats | null> {
	try {
		return await lstat(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
}

/**
 * List the project file set (`project-files.ts`) with each file's size,
 * reading no file: only `poli-page.json`, `tailwind.css`, `templates/`,
 * `partials/` and `assets/` are walked, no directory of
 * `IGNORED_DIRECTORY_NAMES` is entered, and symlinks are neither listed nor
 * followed. Throws a `UsageError` naming the file, or the limit, as soon as
 * the set passes one of the API's limits, so a command calls it before any
 * request.
 */
export async function listProjectFiles(cwd: string): Promise<ProjectFileStat[]> {
	const files: ProjectFileStat[] = [];
	let totalBytes = 0;

	function add(path: string, size: number): void {
		if (size > PROJECT_FILE_MAX_BYTES) throw tooLarge(path, size);
		if (files.length === PROJECT_MAX_FILES) {
			throw new UsageError(
				`The project has more than ${PROJECT_MAX_FILES} files, the most a project may hold. Remove some from templates/, partials/ or assets/.`
			);
		}
		totalBytes += size;
		if (totalBytes > PROJECT_MAX_TOTAL_BYTES) throw tooManyBytes(path);
		files.push({ path, size });
	}

	async function walk(dirPath: string): Promise<void> {
		const names = (await readdir(join(cwd, dirPath))).sort();
		for (const name of names) {
			const path = `${dirPath}/${name}`;
			const stats = await lstatIfExists(join(cwd, path));
			if (stats?.isDirectory()) {
				if (!isInIgnoredProjectDirectory(path)) await walk(path);
			} else if (stats?.isFile() && !shouldIgnoreProjectPath(path)) {
				add(path, stats.size);
			}
		}
	}

	for (const path of PROJECT_ROOT_FILES) {
		const stats = await lstatIfExists(join(cwd, path));
		if (stats?.isFile()) add(path, stats.size);
	}
	for (const path of PROJECT_ROOT_DIRECTORIES) {
		const stats = await lstatIfExists(join(cwd, path));
		if (stats?.isDirectory()) await walk(path);
	}
	return files;
}

// `O_NOFOLLOW` does not exist on Windows.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/**
 * Read one listed file. The open does not follow a symlink and the size is
 * checked again on the open file: either may have changed since the listing.
 * The file may still grow after that check, so at most one byte past the
 * limit is read.
 */
async function readListedFile(cwd: string, file: ProjectFileStat): Promise<Buffer> {
	const handle = await open(join(cwd, file.path), READ_FLAGS);
	try {
		const stats = await handle.stat();
		if (stats.size > PROJECT_FILE_MAX_BYTES) throw tooLarge(file.path, stats.size);
		const chunks: Buffer[] = [];
		for await (const chunk of handle.createReadStream({
			start: 0,
			end: PROJECT_FILE_MAX_BYTES,
			autoClose: false,
		})) {
			chunks.push(chunk as Buffer);
		}
		const buffer = Buffer.concat(chunks);
		if (buffer.length > PROJECT_FILE_MAX_BYTES) {
			// The read stops one byte past the limit, so the file's real size is unknown.
			throw new UsageError(
				`${file.path} is over ${mebibytes(PROJECT_FILE_MAX_BYTES)}, the most a project file may be (it grew while it was read). Shrink it or move it out of the project.`
			);
		}
		return buffer;
	} finally {
		await handle.close();
	}
}

/**
 * Read every file of the project file set (`listProjectFiles`, with its
 * limits) into a `path → content` map. The total is checked again on the
 * bytes read: files may have grown since the listing.
 *
 * Paths are project-relative and POSIX-normalised so the wire format
 * matches the comparisons performed by the API regardless of host OS.
 * Content is already encoded as `projectFileEncoding` says: base64 for
 * assets, utf-8 verbatim for everything else.
 */
export async function readAllProjectFiles(cwd: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	let totalBytes = 0;
	for (const file of await listProjectFiles(cwd)) {
		const buffer = await readListedFile(cwd, file);
		totalBytes += buffer.length;
		if (totalBytes > PROJECT_MAX_TOTAL_BYTES) throw tooManyBytes(file.path);
		out.set(
			file.path,
			buffer.toString(projectFileEncoding(file.path) === 'base64' ? 'base64' : 'utf-8')
		);
	}
	return out;
}

export interface ProjectSyncOutcome {
	/** `false` when the on-disk content was byte-identical to the snapshot. */
	changed: boolean;
	syncedAt?: string;
	/** Project-relative POSIX paths touched by this sync (added + modified + deleted). */
	changedPaths: string[];
}

export interface ProjectSyncerOptions {
	cwd: string;
	client: ApiClient;
	ctx: CloudContext;
	signal?: AbortSignal;
}

/**
 * Stateful local ⇄ cloud-draft synchroniser shared by `poli watch` and
 * `poli dev`.
 *
 * It owns the SHA-256 snapshot of the working tree; `sync()` diffs the
 * current tree against that snapshot and pushes only the delta through
 * `PATCH /files`, retrying transient failures via `syncWithRetry`.
 */
export interface ProjectSyncer {
	/** Number of files in the current snapshot. */
	readonly trackedCount: number;
	/** Take the initial snapshot without pushing anything. */
	prime(): Promise<number>;
	/** Push the delta between the snapshot and the working tree. */
	sync(): Promise<ProjectSyncOutcome>;
	/**
	 * Push the whole working tree as `modified`, regardless of the
	 * snapshot. Used at `poli dev` start-up so the first render reflects
	 * the local files rather than whatever the draft happened to hold.
	 */
	syncAll(): Promise<ProjectSyncOutcome>;
}

export function createProjectSyncer(options: ProjectSyncerOptions): ProjectSyncer {
	let hashes = new Map<string, string>();

	async function push(
		body: PatchFilesBody,
		newHashes: Map<string, string>
	): Promise<ProjectSyncOutcome> {
		const result = await syncWithRetry({
			syncFn: () =>
				options.client.patchFiles(
					options.ctx.session,
					options.ctx.orgId,
					options.ctx.projectId,
					body
				),
			signal: options.signal,
		});
		hashes = newHashes;
		return {
			changed: true,
			syncedAt: result.syncedAt,
			changedPaths: [
				...body.added.map((e) => e.path),
				...body.modified.map((e) => e.path),
				...body.deleted,
			],
		};
	}

	return {
		get trackedCount() {
			return hashes.size;
		},

		async prime() {
			const files = await readAllProjectFiles(options.cwd);
			const next = new Map<string, string>();
			for (const [path, content] of files) {
				next.set(path, hashContent(content));
			}
			hashes = next;
			return hashes.size;
		},

		async sync() {
			const newFiles = await readAllProjectFiles(options.cwd);
			const delta = computeDelta(hashes, newFiles);

			if (
				delta.added.length === 0 &&
				delta.modified.length === 0 &&
				delta.deleted.length === 0
			) {
				hashes = delta.newHashes;
				return { changed: false, changedPaths: [] };
			}

			return push(
				{ added: delta.added, modified: delta.modified, deleted: delta.deleted },
				delta.newHashes
			);
		},

		async syncAll() {
			const newFiles = await readAllProjectFiles(options.cwd);
			const newHashes = new Map<string, string>();
			for (const [path, content] of newFiles) {
				newHashes.set(path, hashContent(content));
			}
			const modified = toProjectFileEntries(newFiles);

			if (modified.length === 0) {
				hashes = newHashes;
				return { changed: false, changedPaths: [] };
			}

			return push({ added: [], modified, deleted: [] }, newHashes);
		},
	};
}
