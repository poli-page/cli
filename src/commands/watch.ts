import { Command } from 'commander';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
	createApiClient,
	SystemProjectLockedError,
	type ApiClient,
} from '../api-client.js';
import { resolveCloudContext } from '../cloud-context.js';
import {
	createFileWatcher,
	type FileWatcher,
	type FileWatcherOptions,
} from '../file-watcher.js';
import { computeDelta, hashContent, syncWithRetry } from '../sync-engine.js';
import { errorToExitCode } from '../exit-codes.js';

export type WatchEventType = 'ready' | 'syncing' | 'synced' | 'error';

export interface WatchEvent {
	type: WatchEventType;
	message?: string;
	syncedAt?: string;
}

export interface WatchOptions {
	cwd?: string;
	homeDir?: string;
	apiClient?: ApiClient;
	isTTY?: boolean;
	signal?: AbortSignal;
	watcherFactory?: (options: FileWatcherOptions) => FileWatcher;
	debounceMs?: number;
	onEvent?: (event: WatchEvent) => void;
}

export class TtyRequiredError extends Error {
	readonly exitCode = 2;
	constructor() {
		super('poli watch requires a TTY (interactive terminal). Refused.');
	}
}

const SYSTEM_PROJECT_FRIENDLY =
	'`getting-started` is read-only. Run `poli init` to start your own project.';

export async function executeWatch(options: WatchOptions): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);

	if (!isTTY) {
		throw new TtyRequiredError();
	}

	const { client, ctx } = await resolveCloudContext({
		cwd,
		apiClient: options.apiClient,
		homeDir: options.homeDir,
	});

	let hashes = new Map<string, string>();
	const initialFiles = await readAllFiles(cwd);
	for (const [path, content] of initialFiles) {
		hashes.set(path, hashContent(content));
	}

	options.onEvent?.({ type: 'ready', message: `tracking ${hashes.size} file(s)` });

	let fatal: Error | null = null;
	const factory = options.watcherFactory ?? createFileWatcher;
	const watcher = factory({
		cwd,
		debounceMs: options.debounceMs ?? 2000,
		onBatch: async (_paths) => {
			if (options.signal?.aborted) return;
			try {
				options.onEvent?.({ type: 'syncing' });
				const newFiles = await readAllFiles(cwd);
				const delta = computeDelta(hashes, newFiles);

				if (
					delta.added.length === 0 &&
					delta.modified.length === 0 &&
					delta.deleted.length === 0
				) {
					hashes = delta.newHashes;
					options.onEvent?.({ type: 'synced', message: 'no changes' });
					return;
				}

				const result = await syncWithRetry({
					syncFn: () =>
						client.patchFiles(ctx.session, ctx.orgId, ctx.projectId, {
							added: delta.added,
							modified: delta.modified,
							deleted: delta.deleted,
						}),
					signal: options.signal,
				});
				hashes = delta.newHashes;
				options.onEvent?.({ type: 'synced', syncedAt: result.syncedAt });
			} catch (err) {
				if (err instanceof SystemProjectLockedError) {
					options.onEvent?.({
						type: 'error',
						message: SYSTEM_PROJECT_FRIENDLY,
					});
					fatal = err;
					return;
				}
				options.onEvent?.({
					type: 'error',
					message: err instanceof Error ? err.message : 'Unknown error',
				});
			}
		},
	});

	await new Promise<void>((resolve) => {
		const finish = () => resolve();
		if (options.signal) {
			if (options.signal.aborted) {
				finish();
				return;
			}
			options.signal.addEventListener('abort', finish, { once: true });
		}
		// Also resolve when a fatal error has been recorded — poll briefly.
		const interval = setInterval(() => {
			if (fatal) {
				clearInterval(interval);
				finish();
			}
		}, 25);
		// Cleanup after the resolver fires.
		setTimeout(() => clearInterval(interval), 60_000).unref?.();
	});

	await watcher.close();
	if (fatal) throw fatal;
}

async function readAllFiles(cwd: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const entries = await readdir(cwd, { recursive: true, withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const parentDir = (entry as unknown as { parentPath?: string; path?: string }).parentPath
			?? (entry as unknown as { parentPath?: string; path?: string }).path
			?? cwd;
		const absolutePath = join(parentDir, entry.name);
		const relPath = relative(cwd, absolutePath);
		if (shouldIgnore(relPath)) continue;
		const content = await readFile(absolutePath, 'utf-8');
		out.set(relPath, content);
	}
	return out;
}

function shouldIgnore(relPath: string): boolean {
	const segments = relPath.split('/');
	if (segments.includes('node_modules')) return true;
	if (segments.includes('.git')) return true;
	if (segments.includes('output')) return true;
	if (segments.includes('dist')) return true;
	if (relPath.endsWith('.DS_Store')) return true;
	if (relPath.endsWith('.log')) return true;
	return false;
}

export function registerWatchCommand(program: Command): void {
	program
		.command('watch')
		.description(
			'Sync the local project to the cloud draft on each save (debounced 2s)'
		)
		.action(async () => {
			const { default: chalk } = await import('chalk');
			const controller = new AbortController();
			const onSigint = () => controller.abort();
			process.on('SIGINT', onSigint);

			try {
				await executeWatch({
					signal: controller.signal,
					onEvent: (e) => {
						const ts = new Date().toLocaleTimeString();
						switch (e.type) {
							case 'ready':
								console.log(
									chalk.cyan(
										`▸ poli watch ready — ${e.message ?? ''}\n  Watching for changes... (Ctrl-C to stop)\n`
									)
								);
								break;
							case 'syncing':
								process.stdout.write(chalk.dim(`[${ts}] syncing...`));
								break;
							case 'synced':
								process.stdout.write(
									chalk.green(`\r[${ts}] ✓ synced${e.message ? ` — ${e.message}` : ''}\n`)
								);
								break;
							case 'error':
								process.stdout.write(
									chalk.red(`\r[${ts}] ✗ ${e.message ?? 'sync error'}\n`)
								);
								break;
						}
					},
				});
				console.log(chalk.dim('\nWatch stopped.'));
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'Watch failed';
				console.error(chalk.red(msg));
				process.exitCode = errorToExitCode(err);
			} finally {
				process.removeListener('SIGINT', onSigint);
			}
		});
}
