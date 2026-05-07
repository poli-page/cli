import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeWatch, type WatchEvent } from '../../src/commands/watch.js';
import { writeCredentials } from '../../src/credentials.js';
import {
	type ApiClient,
	SystemProjectLockedError,
} from '../../src/api-client.js';
import type { FileWatcher, FileWatcherOptions } from '../../src/file-watcher.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';

function makeStubClient(overrides: Partial<ApiClient> = {}): ApiClient {
	return {
		signIn: async () => ({ user: { id: 'u', name: 'n', email: 'e' }, session: 's' }),
		signUp: async () => ({ user: { id: 'u', name: 'n', email: 'e' }, session: 's' }),
		deviceRequest: async () => ({
			deviceCode: 'd',
			userCode: 'u',
			verificationUrl: 'http://x',
			expiresIn: 1,
			interval: 1,
		}),
		devicePoll: async () => ({ status: 'authorization_pending' as const }),
		getOrganizations: async () => [{ id: 'org_1', name: 'Acme', slug: 'acme' }],
		listProjects: async () => [],
		createProject: async () => ({ id: 'p' }),
		updateProject: async () => {},
		patchFiles: async () => ({ syncedAt: '2026-05-06T10:00:00.000Z' }),
		createApiKey: async () => ({
			key: 'pp_test_x',
			info: { id: 'k', name: 'n', environment: 'test' },
		}),
		render: async () => { throw new Error('not implemented in stub'); },
		getMe: async () => {
			throw new Error('not implemented in stub');
		},
		pushVersion: async () => ({
			id: 'v',
			version: '1.0.0',
			major: 1,
			minor: 0,
			patch: 0,
			state: 'SANDBOX' as const,
			createdAt: '',
		}),
		listVersions: async () => [],
		promoteVersion: async () => ({
			id: 'v',
			version: '1.0.0',
			major: 1,
			minor: 0,
			patch: 0,
			state: 'LIVE' as const,
			createdAt: '',
		}),
		unpromoteVersion: async () => ({
			id: 'v',
			version: '1.0.0',
			major: 1,
			minor: 0,
			patch: 0,
			state: 'SANDBOX' as const,
			createdAt: '',
		}),
		unpromotePreview: async () => ({
			currentLatestLive: null,
			newLatestLiveAfterUnpromote: null,
			willHaveNoLive: true,
			recentLiveCalls: 0,
		}),
		deprecateVersion: async () => ({
			id: 'v',
			version: '1.0.0',
			major: 1,
			minor: 0,
			patch: 0,
			state: 'DEPRECATED' as const,
			createdAt: '',
		}),
		undeprecateVersion: async () => ({
			id: 'v',
			version: '1.0.0',
			major: 1,
			minor: 0,
			patch: 0,
			state: 'SANDBOX' as const,
			createdAt: '',
		}),
		downloadVersion: async () => ({ manifest: {}, templates: [] }),
		getDocument: async () => {
			throw new Error('not implemented in stub');
		},
		deleteDocument: async () => {},
		documentThumbnails: async () => [],
		documentPreview: async () => ({ html: '', pageCount: 0 }),
		...overrides,
	};
}

interface ManualWatcher {
	emit(paths: string[]): Promise<void>;
	closed: boolean;
}

function createManualWatcherFactory(): {
	factory: (opts: FileWatcherOptions) => FileWatcher;
	getController: () => ManualWatcher;
} {
	let controller: ManualWatcher | null = null;
	const factory = (opts: FileWatcherOptions): FileWatcher => {
		const local: ManualWatcher = {
			closed: false,
			async emit(paths) {
				opts.onBatch(new Set(paths));
				// Allow the async onBatch handler to settle before the test continues.
				await Promise.resolve();
			},
		};
		controller = local;
		return {
			async close() {
				local.closed = true;
			},
		};
	};
	return { factory, getController: () => controller! };
}

async function setupLinkedProject(
	tempDir: string,
	fakeHome: string
): Promise<void> {
	await writeFile(
		join(tempDir, MANIFEST_FILENAME),
		JSON.stringify({
			project: { name: 'demo', version: '0.1.0' },
			cloud: {
				orgSlug: 'acme',
				orgId: 'org_1',
				projectSlug: 'invoices',
				projectId: 'proj_1',
			},
			templates: [],
		})
	);
	await writeCredentials(
		{
			session: 'sess-tok',
			user: { id: 'u', name: 'X', email: 'x@x.com' },
			orgs: { acme: {} },
		},
		fakeHome
	);
}

describe('executeWatch', () => {
	let tempDir: string;
	let fakeHome: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-watch-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-watch-home-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	it('refuses to start when not running in a TTY (exit 2)', async () => {
		await setupLinkedProject(tempDir, fakeHome);

		const err = await executeWatch({
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: makeStubClient(),
			isTTY: false,
		}).catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		expect(err.exitCode).toBe(2);
		expect(err.message).toMatch(/TTY/i);
	});

	it('throws a friendly error when the project is not linked', async () => {
		await writeFile(
			join(tempDir, MANIFEST_FILENAME),
			JSON.stringify({
				project: { name: 'demo', version: '0.1.0' },
				templates: [],
			})
		);
		await writeCredentials(
			{
				session: 'sess-tok',
				user: { id: 'u', name: 'X', email: 'x@x.com' },
				orgs: {},
			},
			fakeHome
		);

		const controller = new AbortController();
		await expect(
			executeWatch({
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: makeStubClient(),
				isTTY: true,
				signal: controller.signal,
			})
		).rejects.toThrow(/not linked|poli link/i);
	});

	it('emits a "ready" event after the initial snapshot, then "syncing" → "synced" on save', async () => {
		await setupLinkedProject(tempDir, fakeHome);
		await mkdir(join(tempDir, 'templates'), { recursive: true });
		await writeFile(join(tempDir, 'templates', 'inv.html'), '<h1>v1</h1>');

		const events: WatchEvent[] = [];
		const controller = new AbortController();
		const { factory, getController } = createManualWatcherFactory();

		let patchCalls: Array<{ added: number; modified: number; deleted: number }> = [];
		const client = makeStubClient({
			patchFiles: async (_session, _orgId, _projectId, body) => {
				patchCalls.push({
					added: body.added.length,
					modified: body.modified.length,
					deleted: body.deleted.length,
				});
				return { syncedAt: '2026-05-06T10:00:00.000Z' };
			},
		});

		const runPromise = executeWatch({
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
			isTTY: true,
			signal: controller.signal,
			watcherFactory: factory,
			onEvent: (e) => events.push(e),
		});

		// Wait for the initial-snapshot 'ready' event to be emitted.
		await new Promise((r) => setTimeout(r, 50));

		expect(events.some((e) => e.type === 'ready')).toBe(true);
		expect(patchCalls).toHaveLength(0);

		// Simulate a save event
		await writeFile(join(tempDir, 'templates', 'inv.html'), '<h1>v2</h1>');
		await getController().emit(['templates/inv.html']);
		await new Promise((r) => setTimeout(r, 50));

		expect(patchCalls).toHaveLength(1);
		expect(patchCalls[0]).toEqual({ added: 0, modified: 1, deleted: 0 });
		expect(events.some((e) => e.type === 'syncing')).toBe(true);
		expect(events.some((e) => e.type === 'synced')).toBe(true);

		controller.abort();
		await runPromise;
		expect(getController().closed).toBe(true);
	});

	it('translates SYSTEM_PROJECT_LOCKED into a friendly message and aborts', async () => {
		await setupLinkedProject(tempDir, fakeHome);
		await writeFile(join(tempDir, 'a.html'), 'init');

		const events: WatchEvent[] = [];
		const controller = new AbortController();
		const { factory, getController } = createManualWatcherFactory();

		const client = makeStubClient({
			patchFiles: async () => {
				throw new SystemProjectLockedError('system project');
			},
		});

		const runPromise = executeWatch({
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
			isTTY: true,
			signal: controller.signal,
			watcherFactory: factory,
			onEvent: (e) => events.push(e),
		}).catch((err) => err);

		await new Promise((r) => setTimeout(r, 50));
		await writeFile(join(tempDir, 'a.html'), 'change');
		await getController().emit(['a.html']);

		const result = await runPromise;
		expect(result).toBeInstanceOf(SystemProjectLockedError);

		const errorEvent = events.find((e) => e.type === 'error');
		expect(errorEvent).toBeDefined();
		expect(errorEvent!.message).toMatch(/getting-started|read-only|poli init/i);
	});

	it('emits "synced" with no patchFiles call when the batch contains no real changes', async () => {
		await setupLinkedProject(tempDir, fakeHome);
		await writeFile(join(tempDir, 'a.html'), 'same');

		const events: WatchEvent[] = [];
		const controller = new AbortController();
		const { factory, getController } = createManualWatcherFactory();

		let patchCalled = 0;
		const client = makeStubClient({
			patchFiles: async () => {
				patchCalled += 1;
				return { syncedAt: '' };
			},
		});

		const runPromise = executeWatch({
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
			isTTY: true,
			signal: controller.signal,
			watcherFactory: factory,
			onEvent: (e) => events.push(e),
		});

		await new Promise((r) => setTimeout(r, 50));
		// Re-emit without any actual content change
		await getController().emit(['a.html']);
		await new Promise((r) => setTimeout(r, 50));

		expect(patchCalled).toBe(0);
		expect(events.some((e) => e.type === 'synced')).toBe(true);

		controller.abort();
		await runPromise;
	});
});
