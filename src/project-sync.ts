import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ApiClient, PatchFilesEntry } from './api-client.js';
import type { CloudContext } from './cloud-context.js';
import { MANIFEST_FILENAME } from './constants.js';
import { computeDelta, hashContent, syncWithRetry } from './sync-engine.js';

/**
 * File extensions that the API treats as opaque binary assets (images,
 * fonts) and decodes via `Buffer.from(content, 'base64')`. The CLI must
 * therefore send their content base64-encoded — reading them as utf-8
 * silently corrupts the bytes on the way to the server. The list mirrors
 * the API's `resolveContentType` allowlist. SVG is included even though
 * it is XML on disk because the API treats it the same way as raster
 * images.
 */
const BINARY_ASSET_EXTENSIONS = new Set([
	'png',
	'jpg',
	'jpeg',
	'gif',
	'svg',
	'webp',
	'woff',
	'woff2',
	'ttf',
	'otf',
]);

export function isBinaryAsset(relPath: string): boolean {
	const ext = relPath.split('.').pop()?.toLowerCase();
	return ext !== undefined && BINARY_ASSET_EXTENSIONS.has(ext);
}

/**
 * Files the API's `patchFiles` accepts: the manifest and `tailwind.css` by
 * exact name, any `.html` or `.json`, and assets whose extension maps to a
 * recognised image or font content type. Everything else is refused with a
 * 400 (`UnsupportedFileTypeError`), so uploading it can only ever fail the
 * sync — `.gitignore` and `.prettierignore`, both scaffolded by `poli init`
 * itself, are the ones every project hits.
 *
 * This mirrors an allowlist rather than extending the denylist below, so a
 * stray `.env`, `.bak` or `README.md` dropped into a project is skipped
 * instead of breaking the sync for every other file in the batch.
 */
const SYNCABLE_EXACT_NAMES = new Set([MANIFEST_FILENAME, 'tailwind.css']);
const SYNCABLE_TEXT_EXTENSIONS = new Set(['html', 'json']);

function isSyncableProjectFile(relPath: string): boolean {
	if (SYNCABLE_EXACT_NAMES.has(relPath)) return true;
	const ext = relPath.split('.').pop()?.toLowerCase();
	if (ext === undefined) return false;
	return SYNCABLE_TEXT_EXTENSIONS.has(ext) || BINARY_ASSET_EXTENSIONS.has(ext);
}

export function shouldIgnoreProjectPath(relPath: string): boolean {
	const segments = relPath.split('/');
	if (segments.includes('node_modules')) return true;
	if (segments.includes('.git')) return true;
	if (segments.includes('output')) return true;
	if (segments.includes('dist')) return true;
	if (relPath.endsWith('.DS_Store')) return true;
	if (relPath.endsWith('.log')) return true;
	return !isSyncableProjectFile(relPath);
}

/**
 * Read every syncable file of a project into a `path → content` map.
 *
 * Paths are project-relative and POSIX-normalised so the wire format
 * matches the comparisons performed by the API regardless of host OS.
 * Binary assets are base64-encoded; everything else is utf-8 verbatim.
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
		if (isBinaryAsset(wirePath)) {
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
		body: { added: PatchFilesEntry[]; modified: PatchFilesEntry[]; deleted: string[] },
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
			const modified: PatchFilesEntry[] = [];
			for (const [path, content] of newFiles) {
				newHashes.set(path, hashContent(content));
				modified.push({ path, content });
			}

			if (modified.length === 0) {
				hashes = newHashes;
				return { changed: false, changedPaths: [] };
			}

			return push({ added: [], modified, deleted: [] }, newHashes);
		},
	};
}
