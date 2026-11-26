import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeWatch, type WatchEvent } from '../../src/commands/watch.js';
import { writeCredentials } from '../../src/credentials.js';
import { recordLink } from '../../src/cloud-link.js';
import {
	type ApiClient,
	type PatchFilesBody,
	UnsupportedFileTypeError,
} from '../../src/api-client.js';
import type { FileWatcher, FileWatcherOptions } from '../../src/file-watcher.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';
import { createFakeApiClient } from '../helpers/fake-api-client.js';

function makeStubClient(overrides: Partial<ApiClient> = {}): ApiClient {
	return createFakeApiClient({
		getOrganizations: async () => [
			{ id: '0e89d99e-1516-4b48-baa1-f49e660ad1c1', name: 'Acme', slug: 'acme' },
		],
		listProjects: async () => [
			{ id: '8274f64d-4ea2-4f96-b596-5727a7b17268', name: 'Invoices', slug: 'invoices' },
		],
		...overrides,
	});
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

async function setupLinkedProject(tempDir: string, fakeHome: string): Promise<void> {
	await setupClonedProject(tempDir, fakeHome);
	await recordLink(tempDir, '8274f64d-4ea2-4f96-b596-5727a7b17268', fakeHome);
}

/** A linked manifest as a clone brings it: no confirmed link on this machine. */
async function setupClonedProject(tempDir: string, fakeHome: string): Promise<void> {
	await writeFile(
		join(tempDir, MANIFEST_FILENAME),
		JSON.stringify({
			project: { name: 'demo' },
			cloud: {
				orgSlug: 'acme',
				orgId: '0e89d99e-1516-4b48-baa1-f49e660ad1c1',
				projectSlug: 'invoices',
				projectId: '8274f64d-4ea2-4f96-b596-5727a7b17268',
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
				project: { name: 'demo' },
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

	describe('a cloned folder (cloud block, no confirmed link)', () => {
		it('refuses without a confirmLink prompt (exit 2), naming org and project, before any sync', async () => {
			await setupClonedProject(tempDir, fakeHome);
			const patchFiles = vi.fn();

			const err = await executeWatch({
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: makeStubClient({ patchFiles }),
				isTTY: true,
			}).catch((e) => e);

			expect(err.exitCode).toBe(2);
			expect(err.message).toMatch(/"Invoices" \(invoices\) of organization "Acme" \(acme\)/);
			expect(err.message).toMatch(/poli link/);
			expect(patchFiles).not.toHaveBeenCalled();
		});

		it('asks once: a confirmed link is recorded and the next run does not ask', async () => {
			await setupClonedProject(tempDir, fakeHome);
			const confirmLink = vi.fn(async () => true);

			for (let run = 0; run < 2; run++) {
				const controller = new AbortController();
				const { factory } = createManualWatcherFactory();
				const ready = new Promise<void>((resolve) => {
					void executeWatch({
						cwd: tempDir,
						homeDir: fakeHome,
						apiClient: makeStubClient(),
						isTTY: true,
						signal: controller.signal,
						watcherFactory: factory,
						confirmLink,
						onEvent: (e) => {
							if (e.type === 'ready') resolve();
						},
					});
				});
				await ready;
				controller.abort();
			}

			expect(confirmLink).toHaveBeenCalledTimes(1);
			expect(confirmLink).toHaveBeenCalledWith({
				org: { id: '0e89d99e-1516-4b48-baa1-f49e660ad1c1', name: 'Acme', slug: 'acme' },
				project: {
					id: '8274f64d-4ea2-4f96-b596-5727a7b17268',
					name: 'Invoices',
					slug: 'invoices',
				},
			});
			const links = JSON.parse(
				await readFile(join(fakeHome, '.polipage', 'links.json'), 'utf-8')
			);
			expect(links.links[await realpath(tempDir)]).toBe(
				'8274f64d-4ea2-4f96-b596-5727a7b17268'
			);
		});

		it('does not sync and records nothing when the user declines', async () => {
			await setupClonedProject(tempDir, fakeHome);
			const patchFiles = vi.fn();

			await expect(
				executeWatch({
					cwd: tempDir,
					homeDir: fakeHome,
					apiClient: makeStubClient({ patchFiles }),
					isTTY: true,
					confirmLink: async () => false,
				})
			).rejects.toThrow(/cancelled/i);

			expect(patchFiles).not.toHaveBeenCalled();
			await expect(stat(join(fakeHome, '.polipage', 'links.json'))).rejects.toThrow(/ENOENT/);
		});

		it('asks again when the manifest now names another project', async () => {
			await setupClonedProject(tempDir, fakeHome);
			await recordLink(tempDir, 'proj_other', fakeHome);

			const err = await executeWatch({
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: makeStubClient(),
				isTTY: true,
			}).catch((e) => e);

			expect(err.exitCode).toBe(2);
		});
	});

	it('refuses a manifest whose ids name different projects, before any sync', async () => {
		await setupLinkedProject(tempDir, fakeHome);
		const patchFiles = vi.fn();

		const err = await executeWatch({
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: makeStubClient({
				patchFiles,
				listProjects: async () => [
					{
						id: '8274f64d-4ea2-4f96-b596-5727a7b17268',
						name: 'Payroll',
						slug: 'payroll',
					},
					{ id: 'proj_2', name: 'Invoices', slug: 'invoices' },
				],
			}),
			isTTY: true,
			confirmLink: async () => true,
		}).catch((e) => e);

		expect(err.exitCode).toBe(6);
		expect(err.message).toMatch(/projectSlug "invoices"/);
		expect(patchFiles).not.toHaveBeenCalled();
	});

	it('emits a "ready" event after the initial snapshot, then "syncing" → "synced" on save', async () => {
		await setupLinkedProject(tempDir, fakeHome);
		await mkdir(join(tempDir, 'templates', 'inv'), { recursive: true });
		await writeFile(join(tempDir, 'templates', 'inv', 'inv.html'), '<h1>v1</h1>');

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
		await writeFile(join(tempDir, 'templates', 'inv', 'inv.html'), '<h1>v2</h1>');
		await getController().emit(['templates/inv/inv.html']);
		await new Promise((r) => setTimeout(r, 50));

		expect(patchCalls).toHaveLength(1);
		expect(patchCalls[0]).toEqual({ added: 0, modified: 1, deleted: 0 });
		expect(events.some((e) => e.type === 'syncing')).toBe(true);
		expect(events.some((e) => e.type === 'synced')).toBe(true);

		controller.abort();
		await runPromise;
		expect(getController().closed).toBe(true);
	});

	it('reports a typed API error and keeps watching', async () => {
		await setupLinkedProject(tempDir, fakeHome);
		await mkdir(join(tempDir, 'partials'), { recursive: true });
		await writeFile(join(tempDir, 'partials', 'a.html'), 'init');

		const events: WatchEvent[] = [];
		const controller = new AbortController();
		const { factory, getController } = createManualWatcherFactory();

		let calls = 0;
		const client = makeStubClient({
			patchFiles: async () => {
				calls += 1;
				if (calls === 1) throw new UnsupportedFileTypeError('unsupported file type');
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

		await new Promise((r) => setTimeout(r, 50));
		await writeFile(join(tempDir, 'partials', 'a.html'), 'change');
		await getController().emit(['partials/a.html']);

		await vi.waitFor(() =>
			expect(events.find((e) => e.type === 'error')?.message).toBe('unsupported file type')
		);

		await writeFile(join(tempDir, 'partials', 'a.html'), 'change again');
		await getController().emit(['partials/a.html']);
		await vi.waitFor(() => expect(events.at(-1)?.type).toBe('synced'));
		expect(calls).toBe(2);

		controller.abort();
		await expect(runPromise).resolves.toBeUndefined();
	});

	it('emits "synced" with no patchFiles call when the batch contains no real changes', async () => {
		await setupLinkedProject(tempDir, fakeHome);
		await mkdir(join(tempDir, 'partials'), { recursive: true });
		await writeFile(join(tempDir, 'partials', 'a.html'), 'same');

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
		await getController().emit(['partials/a.html']);
		await new Promise((r) => setTimeout(r, 50));

		expect(patchCalled).toBe(0);
		expect(events.some((e) => e.type === 'synced')).toBe(true);

		controller.abort();
		await runPromise;
	});

	describe('binary assets', () => {
		it('reads .png assets as base64 and round-trips the exact bytes', async () => {
			await setupLinkedProject(tempDir, fakeHome);
			await mkdir(join(tempDir, 'assets', 'images'), { recursive: true });

			// Bytes 0x80 and 0x81 are both invalid UTF-8 continuation bytes —
			// reading them as utf8 collapses them to U+FFFD, so two distinct
			// binaries become indistinguishable strings. The base64 path
			// preserves the byte-exact difference.
			const initialBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x80, 0x00, 0xab]);
			const updatedBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x81, 0x00, 0xcd]);

			await writeFile(join(tempDir, 'assets', 'images', 'logo.png'), initialBytes);

			const events: WatchEvent[] = [];
			const controller = new AbortController();
			const { factory, getController } = createManualWatcherFactory();

			let lastBody: PatchFilesBody | null = null;
			const client = makeStubClient({
				patchFiles: async (_session, _orgId, _projectId, body) => {
					lastBody = body as PatchFilesBody;
					return { syncedAt: '2026-05-09T10:00:00.000Z' };
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

			// Replace the binary with byte-distinct content
			await writeFile(join(tempDir, 'assets', 'images', 'logo.png'), updatedBytes);
			await getController().emit(['assets/images/logo.png']);
			await new Promise((r) => setTimeout(r, 50));

			expect(lastBody).not.toBeNull();
			expect(lastBody!.modified).toHaveLength(1);
			const entry = lastBody!.modified[0];
			expect(entry.path).toBe('assets/images/logo.png');
			expect(entry.encoding).toBe('base64');
			const decoded = Buffer.from(entry.content, 'base64');
			expect(decoded.equals(updatedBytes)).toBe(true);

			controller.abort();
			await runPromise;
		});

		it('keeps text files (.html, .json, .css) as utf-8 verbatim — no base64', async () => {
			await setupLinkedProject(tempDir, fakeHome);
			await mkdir(join(tempDir, 'templates', 'inv'), { recursive: true });
			await writeFile(join(tempDir, 'templates', 'inv', 'inv.html'), '<h1>v1</h1>');

			const controller = new AbortController();
			const { factory, getController } = createManualWatcherFactory();

			let lastBody: PatchFilesBody | null = null;
			const client = makeStubClient({
				patchFiles: async (_session, _orgId, _projectId, body) => {
					lastBody = body as PatchFilesBody;
					return { syncedAt: '2026-05-09T10:00:00.000Z' };
				},
			});

			const runPromise = executeWatch({
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: client,
				isTTY: true,
				signal: controller.signal,
				watcherFactory: factory,
			});

			await new Promise((r) => setTimeout(r, 50));
			await writeFile(
				join(tempDir, 'templates', 'inv', 'inv.html'),
				'<h1>v2 — éléphant</h1>'
			);
			await getController().emit(['templates/inv/inv.html']);
			await new Promise((r) => setTimeout(r, 50));

			expect(lastBody).not.toBeNull();
			expect(lastBody!.modified).toHaveLength(1);
			expect(lastBody!.modified[0]).toEqual({
				path: 'templates/inv/inv.html',
				encoding: 'utf8',
				content: '<h1>v2 — éléphant</h1>',
			});

			controller.abort();
			await runPromise;
		});

		it('detects new fonts (.woff2) added during the session and sends them base64', async () => {
			await setupLinkedProject(tempDir, fakeHome);
			await mkdir(join(tempDir, 'assets', 'fonts'), { recursive: true });

			const fontBytes = Buffer.from([
				0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00, 0xff, 0x80, 0xab,
			]);

			const controller = new AbortController();
			const { factory, getController } = createManualWatcherFactory();

			let lastBody: PatchFilesBody | null = null;
			const client = makeStubClient({
				patchFiles: async (_session, _orgId, _projectId, body) => {
					lastBody = body as PatchFilesBody;
					return { syncedAt: '2026-05-09T10:00:00.000Z' };
				},
			});

			const runPromise = executeWatch({
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: client,
				isTTY: true,
				signal: controller.signal,
				watcherFactory: factory,
			});

			await new Promise((r) => setTimeout(r, 50));

			// Font added AFTER watch started → must be picked up as `added`
			await writeFile(join(tempDir, 'assets', 'fonts', 'inter.woff2'), fontBytes);
			await getController().emit(['assets/fonts/inter.woff2']);
			await new Promise((r) => setTimeout(r, 50));

			expect(lastBody).not.toBeNull();
			expect(lastBody!.added).toHaveLength(1);
			const entry = lastBody!.added[0];
			expect(entry.path).toBe('assets/fonts/inter.woff2');
			expect(entry.encoding).toBe('base64');
			expect(Buffer.from(entry.content, 'base64').equals(fontBytes)).toBe(true);

			controller.abort();
			await runPromise;
		});
	});
});
