import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ApiClient, PatchFilesBody } from './api-client.js';
import type { CloudContext } from './cloud-context.js';
import {
	isAcceptedProjectPath,
	projectFileEncoding,
	toProjectFileEntries,
} from './project-files.js';
import { computeDelta, hashContent, syncWithRetry } from './sync-engine.js';

export function shouldIgnoreProjectPath(relPath: string): boolean {
	// Callers pass the raw output of `relative()`, which is
	// backslash-separated on Windows. Normalise here, at the public
	// boundary, so every rule below sees POSIX segments on every host:
	// `templates\\inv\\inv.html` is in the file set, and
	// `templates\\inv\\node_modules\\x.json` is not.
	const normalized = relPath.split(/[\\/]/).join('/');
	const segments = normalized.split('/');
	if (segments.includes('node_modules')) return true;
	if (segments.includes('.git')) return true;
	if (segments.includes('output')) return true;
	if (segments.includes('dist')) return true;
	if (normalized.endsWith('.DS_Store')) return true;
	if (normalized.endsWith('.log')) return true;
	return !isAcceptedProjectPath(normalized);
}

/**
 * Read every file of the project file set (`project-files.ts`) into a
 * `path → content` map.
 *
 * Paths are project-relative and POSIX-normalised so the wire format
 * matches the comparisons performed by the API regardless of host OS.
 * Content is already encoded as `projectFileEncoding` says: base64 for
 * assets, utf-8 verbatim for everything else.
 */
export async function readAllProjectFiles(cwd: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const entries = await readdir(cwd, { recursive: true, withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const parentDir =
			(entry as unknown as { parentPath?: string; path?: string }).parentPath ??
			(entry as unknown as { parentPath?: string; path?: string }).path ??
			cwd;
		const absolutePath = join(parentDir, entry.name);
		const relPath = relative(cwd, absolutePath);
		if (shouldIgnoreProjectPath(relPath)) continue;
		const wirePath = relPath.split(/[\\/]/).join('/');
		if (projectFileEncoding(wirePath) === 'base64') {
			const buffer = await readFile(absolutePath);
			out.set(wirePath, buffer.toString('base64'));
		} else {
			const content = await readFile(absolutePath, 'utf-8');
			out.set(wirePath, content);
		}
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
