import { Command } from 'commander';
import type { ApiClient } from '../api-client.js';
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
				options.onEvent?.({
					type: 'error',
					message: err instanceof Error ? err.message : 'Unknown error',
				});
			}
		},
	});

	await new Promise<void>((resolve) => {
		if (!options.signal) return;
		if (options.signal.aborted) {
			resolve();
			return;
		}
		options.signal.addEventListener('abort', () => resolve(), { once: true });
	});

	await watcher.close();
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
