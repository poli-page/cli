import { Command } from 'commander';
import { SystemProjectLockedError, type ApiClient } from '../api-client.js';
import { resolveCloudContext } from '../cloud-context.js';
import { createFileWatcher, type FileWatcher, type FileWatcherOptions } from '../file-watcher.js';
import { createProjectSyncer } from '../project-sync.js';
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

export const SYSTEM_PROJECT_FRIENDLY =
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

	const syncer = createProjectSyncer({ cwd, client, ctx, signal: options.signal });
	const tracked = await syncer.prime();

	options.onEvent?.({ type: 'ready', message: `tracking ${tracked} file(s)` });

	let fatal: Error | null = null;
	const factory = options.watcherFactory ?? createFileWatcher;
	const watcher = factory({
		cwd,
		debounceMs: options.debounceMs ?? 2000,
		onBatch: async (_paths) => {
			if (options.signal?.aborted) return;
			try {
				options.onEvent?.({ type: 'syncing' });
				const outcome = await syncer.sync();

				if (!outcome.changed) {
					options.onEvent?.({ type: 'synced', message: 'no changes' });
					return;
				}

				options.onEvent?.({ type: 'synced', syncedAt: outcome.syncedAt });
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

export function registerWatchCommand(program: Command): void {
	program
		.command('watch')
		.description('Sync the local project to the cloud draft on each save (debounced 2s)')
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
									chalk.green(
										`\r[${ts}] ✓ synced${e.message ? ` — ${e.message}` : ''}\n`
									)
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
