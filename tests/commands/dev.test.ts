import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	startDevSession,
	extractErrorPosition,
	attributeChangedTemplate,
	pickFollowTarget,
	parsePort,
	type DevSession,
	type DevEvent,
	type DevState,
} from '../../src/commands/dev.js';
import { createProgram } from '../../src/program.js';
import { writeCredentials } from '../../src/credentials.js';
import { readManifest, writeManifest } from '../../src/manifest.js';
import { setupTemplate } from '../helpers/setup-template.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';
import { ApiError, type ApiClient, type PatchFilesBody } from '../../src/api-client.js';
import type { FileWatcher, FileWatcherOptions } from '../../src/file-watcher.js';

interface RenderCall {
	payload: Record<string, unknown>;
}

interface StubOptions {
	previewCalls?: RenderCall[];
	pdfCalls?: RenderCall[];
	patchBodies?: PatchFilesBody[];
	previewImpl?: (payload: Record<string, unknown>) => Promise<{
		html: string;
		totalPages: number;
		environment: 'sandbox' | 'live';
	}>;
	patchImpl?: (body: PatchFilesBody) => Promise<{ syncedAt: string }>;
}

function makeStubClient(options: StubOptions = {}): ApiClient {
	return {
		getOrganizations: async () => [{ id: 'org_1', name: 'Acme', slug: 'acme' }],
		patchFiles: async (_session, _orgId, _projectId, body) => {
			options.patchBodies?.push(body);
			if (options.patchImpl) return options.patchImpl(body);
			return { syncedAt: '2026-09-01T10:00:00.000Z' };
		},
		renderPreview: async (_authorization, _orgIdHeader, payload) => {
			options.previewCalls?.push({ payload });
			if (options.previewImpl) return options.previewImpl(payload);
			return {
				html: `<html><body>render of ${String(payload.template)}</body></html>`,
				totalPages: 3,
				environment: 'sandbox' as const,
			};
		},
		render: async (_authorization, _orgIdHeader, payload) => {
			options.pdfCalls?.push({ payload });
			return {
				documentId: 'doc_1',
				organizationId: 'org_1',
				projectId: 'proj_1',
				projectSlug: 'demo',
				templateId: 'tpl_1',
				templateSlug: String(payload.template),
				version: null,
				environment: 'sandbox' as const,
				apiKeyId: null,
				createdAt: '2026-09-01T10:00:00.000Z',
				pageCount: 3,
				sizeBytes: 1024,
				format: 'A4',
				orientation: 'portrait',
				locale: null,
				metadata: {},
				presignedPdfUrl: 'https://example.invalid/doc_1.pdf',
				expiresAt: '2026-09-01T11:00:00.000Z',
			};
		},
	} as unknown as ApiClient;
}

interface ManualWatcher {
	emit(paths: string[]): void;
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
			emit(paths) {
				opts.onBatch(new Set(paths));
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

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

interface SseProbe {
	frames: Array<{ event: string; data: string }>;
	close(): void;
}

/** Minimal SSE reader — enough to assert what the browser would receive. */
async function openSse(baseUrl: string): Promise<SseProbe> {
	const controller = new AbortController();
	const response = await fetch(`${baseUrl}/events`, { signal: controller.signal });
	const frames: Array<{ event: string; data: string }> = [];
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	void (async () => {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let index = buffer.indexOf('\n\n');
				while (index !== -1) {
					const raw = buffer.slice(0, index);
					buffer = buffer.slice(index + 2);
					const lines = raw.split('\n');
					const eventLine = lines.find((l) => l.startsWith('event: '));
					const dataLine = lines.find((l) => l.startsWith('data: '));
					if (eventLine && dataLine) {
						frames.push({ event: eventLine.slice(7), data: dataLine.slice(6) });
					}
					index = buffer.indexOf('\n\n');
				}
			}
		} catch {
			// Aborted on close — expected.
		}
	})();

	return { frames, close: () => controller.abort() };
}

async function setupLinkedProject(projectDir: string, fakeHome: string): Promise<void> {
	await writeFile(
		join(projectDir, MANIFEST_FILENAME),
		JSON.stringify({
			project: { name: 'demo', version: '0.1.0' },
			cloud: {
				orgSlug: 'acme',
				orgId: 'org_1',
				projectSlug: 'demo',
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

describe('poli dev', () => {
	let projectDir: string;
	let fakeHome: string;
	let sessions: DevSession[];
	let extraServers: Server[];
	let savedApiKey: string | undefined;

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), 'poli-dev-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-dev-home-'));
		sessions = [];
		extraServers = [];
		savedApiKey = process.env.POLI_PAGE_API_KEY;
		delete process.env.POLI_PAGE_API_KEY;
		await setupLinkedProject(projectDir, fakeHome);
	});

	afterEach(async () => {
		for (const session of sessions) await session.close();
		for (const server of extraServers) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		await rm(projectDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
		if (savedApiKey === undefined) delete process.env.POLI_PAGE_API_KEY;
		else process.env.POLI_PAGE_API_KEY = savedApiKey;
	});

	async function start(
		templateName: string | undefined,
		overrides: Parameters<typeof startDevSession>[1] = {}
	): Promise<DevSession> {
		const session = await startDevSession(templateName, {
			cwd: projectDir,
			homeDir: fakeHome,
			port: 0,
			open: false,
			...overrides,
		});
		sessions.push(session);
		return session;
	}

	describe('command registration', () => {
		const program = createProgram();
		const cmd = program.commands.find((c) => c.name() === 'dev');

		it('is registered on the program', () => {
			expect(cmd).toBeDefined();
			expect(cmd!.description()).toMatch(/live-reloading|preview/i);
		});

		it('takes an optional positional template argument', () => {
			const args = (
				cmd as unknown as {
					registeredArguments: { name(): string; required: boolean }[];
				}
			).registeredArguments;
			expect(args).toHaveLength(1);
			expect(args[0].name()).toBe('template');
			expect(args[0].required).toBe(false);
		});

		it('exposes --port, --data and --no-open', () => {
			const longs = cmd!.options.map((o) => o.long);
			expect(longs).toEqual(expect.arrayContaining(['--port', '--data', '--no-open']));
			expect(cmd!.options.find((o) => o.long === '--port')!.short).toBe('-p');
			expect(cmd!.options.find((o) => o.long === '--data')!.short).toBe('-d');
		});

		it('does not expose a --version option (would clash with the global one)', () => {
			expect(cmd!.options.find((o) => o.long === '--version')).toBeUndefined();
		});

		it('defaults --open to true so --no-open is the opt-out', () => {
			expect(cmd!.opts().open).toBe(true);
			expect(cmd!.parseOptions(['--no-open']).operands).toEqual([]);
			expect(cmd!.opts().open).toBe(false);
		});

		it('validates --port and rejects anything outside 1–65535', () => {
			expect(parsePort('8080')).toBe(8080);
			expect(() => parsePort('0')).toThrow(/between 1 and 65535/);
			expect(() => parsePort('70000')).toThrow(/between 1 and 65535/);
			expect(() => parsePort('abc')).toThrow(/between 1 and 65535/);
			try {
				parsePort('abc');
			} catch (err) {
				expect((err as { exitCode?: number }).exitCode).toBe(2);
			}
		});
	});

	describe('start-up', () => {
		it('does not require a TTY', async () => {
			await setupTemplate(projectDir, 'invoice');
			const savedTty = process.stdout.isTTY;
			try {
				Object.defineProperty(process.stdout, 'isTTY', {
					value: false,
					configurable: true,
				});
				const session = await start(undefined, { apiClient: makeStubClient() });
				expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
				expect(session.getState().activeTemplate).toBe('invoice');
			} finally {
				Object.defineProperty(process.stdout, 'isTTY', {
					value: savedTty,
					configurable: true,
				});
			}
		});

		it('pushes the whole working tree once, then renders the first template', async () => {
			await setupTemplate(projectDir, 'invoice');
			const patchBodies: PatchFilesBody[] = [];
			const previewCalls: RenderCall[] = [];

			await start(undefined, {
				apiClient: makeStubClient({ patchBodies, previewCalls }),
			});

			expect(patchBodies).toHaveLength(1);
			expect(patchBodies[0].added).toHaveLength(0);
			expect(patchBodies[0].deleted).toHaveLength(0);
			const paths = patchBodies[0].modified.map((e) => e.path).sort();
			expect(paths).toContain('poli-page.json');
			expect(paths).toContain('templates/invoice/invoice.html');

			expect(previewCalls).toHaveLength(1);
			expect(previewCalls[0].payload).toMatchObject({
				project: 'demo',
				template: 'invoice',
				version: 'draft',
				format: 'A4',
				orientation: 'portrait',
			});
		});

		it('serves the shell page and the rendered preview', async () => {
			await setupTemplate(projectDir, 'invoice');
			const session = await start(undefined, { apiClient: makeStubClient() });

			const shell = await fetch(session.url);
			expect(shell.status).toBe(200);
			expect(shell.headers.get('content-type')).toMatch(/text\/html/);
			const shellHtml = await shell.text();
			expect(shellHtml).toContain('EventSource');
			expect(shellHtml).toContain('id="template"');
			expect(shellHtml).toContain('Render PDF');

			const preview = await fetch(`${session.url}/preview`);
			expect(await preview.text()).toContain('render of invoice');
		});

		it('starts on the requested port and walks upwards when it is busy', async () => {
			await setupTemplate(projectDir, 'invoice');
			const blocker = createServer(() => {});
			extraServers.push(blocker);
			const busyPort = await new Promise<number>((resolve) => {
				blocker.listen(0, '127.0.0.1', () => {
					const address = blocker.address();
					resolve(typeof address === 'object' && address ? address.port : 0);
				});
			});

			const session = await start(undefined, {
				apiClient: makeStubClient(),
				port: busyPort,
			});
			expect(session.port).toBe(busyPort + 1);
		});

		it('rejects when the project is not linked', async () => {
			await writeFile(
				join(projectDir, MANIFEST_FILENAME),
				JSON.stringify({ project: { name: 'demo', version: '0.1.0' }, templates: [] })
			);
			await expect(
				startDevSession(undefined, {
					cwd: projectDir,
					homeDir: fakeHome,
					port: 0,
					open: false,
					apiClient: makeStubClient(),
				})
			).rejects.toThrow(/not linked|poli link/i);
		});

		it('rejects when the positional template is not in the manifest', async () => {
			await setupTemplate(projectDir, 'invoice');
			await expect(
				startDevSession('nope', {
					cwd: projectDir,
					homeDir: fakeHome,
					port: 0,
					open: false,
					apiClient: makeStubClient(),
				})
			).rejects.toThrow(/Template "nope" not found/);
		});

		it('opens the browser unless --no-open is passed', async () => {
			await setupTemplate(projectDir, 'invoice');
			const opened: string[] = [];
			const session = await start(undefined, {
				apiClient: makeStubClient(),
				open: true,
				openFn: async (url) => {
					opened.push(url);
				},
			});
			expect(opened).toEqual([session.url]);

			const notOpened: string[] = [];
			await start(undefined, {
				apiClient: makeStubClient(),
				open: false,
				openFn: async (url) => {
					notOpened.push(url);
				},
			});
			expect(notOpened).toEqual([]);
		});
	});

	describe('sync → render → broadcast', () => {
		it('syncs the delta, re-renders and pushes new state over SSE', async () => {
			await setupTemplate(projectDir, 'invoice');
			const patchBodies: PatchFilesBody[] = [];
			const previewCalls: RenderCall[] = [];
			const { factory, getController } = createManualWatcherFactory();

			const session = await start(undefined, {
				apiClient: makeStubClient({ patchBodies, previewCalls }),
				watcherFactory: factory,
			});

			const sse = await openSse(session.url);
			const versionBefore = session.getState().renderVersion;

			await writeFile(
				join(projectDir, 'templates', 'invoice', 'invoice.html'),
				'<h1>v2</h1>'
			);
			getController().emit(['templates/invoice/invoice.html']);

			await waitFor(
				() => session.getState().renderVersion > versionBefore,
				'a new render version'
			);

			// One start-up push + one delta push.
			expect(patchBodies).toHaveLength(2);
			expect(patchBodies[1].modified.map((e) => e.path)).toEqual([
				'templates/invoice/invoice.html',
			]);
			expect(previewCalls).toHaveLength(2);

			await waitFor(
				() =>
					sse.frames.some(
						(f) =>
							f.event === 'state' &&
							(JSON.parse(f.data) as DevState).renderVersion > versionBefore
					),
				'an SSE state frame carrying the new render version'
			);
			sse.close();
		});

		it('emits a rendering → rendered event pair, never a timer-driven render', async () => {
			await setupTemplate(projectDir, 'invoice');
			const events: DevEvent[] = [];
			const previewCalls: RenderCall[] = [];
			const { factory } = createManualWatcherFactory();

			await start(undefined, {
				apiClient: makeStubClient({ previewCalls }),
				watcherFactory: factory,
				onEvent: (e) => events.push(e),
			});

			expect(events.map((e) => e.type)).toEqual([
				'ready',
				'syncing',
				'rendering',
				'rendered',
			]);

			// No watcher batch → no further renders, however long we wait.
			await new Promise((r) => setTimeout(r, 250));
			expect(previewCalls).toHaveLength(1);
		});
	});

	describe('template switching and pin', () => {
		async function twoTemplates(): Promise<void> {
			await setupTemplate(projectDir, 'invoice');
			await setupTemplate(projectDir, 'receipt');
		}

		it('switches the active template through POST /api/select', async () => {
			await twoTemplates();
			const previewCalls: RenderCall[] = [];
			const session = await start(undefined, {
				apiClient: makeStubClient({ previewCalls }),
			});

			expect(session.getState().activeTemplate).toBe('invoice');

			const response = await fetch(`${session.url}/api/select?template=receipt`, {
				method: 'POST',
			});
			expect(response.status).toBe(200);

			await waitFor(
				() => previewCalls.some((c) => c.payload.template === 'receipt'),
				'a render of the newly selected template'
			);
			expect(session.getState().activeTemplate).toBe('receipt');
		});

		it('answers 404 for a template that is not in the manifest', async () => {
			await twoTemplates();
			const session = await start(undefined, { apiClient: makeStubClient() });
			const response = await fetch(`${session.url}/api/select?template=ghost`, {
				method: 'POST',
			});
			expect(response.status).toBe(404);
			expect(session.getState().activeTemplate).toBe('invoice');
			// The server is still alive and serving.
			expect((await fetch(`${session.url}/state`)).status).toBe(200);
		});

		it('follows the most recently changed template by default', async () => {
			await twoTemplates();
			const { factory, getController } = createManualWatcherFactory();
			const session = await start(undefined, {
				apiClient: makeStubClient(),
				watcherFactory: factory,
			});
			expect(session.getState().activeTemplate).toBe('invoice');

			await writeFile(
				join(projectDir, 'templates', 'receipt', 'receipt.html'),
				'<h1>receipt v2</h1>'
			);
			getController().emit(['templates/receipt/receipt.html']);

			await waitFor(
				() => session.getState().activeTemplate === 'receipt',
				'the view to follow the changed template'
			);
		});

		it('keeps the current template when a shared file changes', async () => {
			await twoTemplates();
			await mkdir(join(projectDir, 'partials'), { recursive: true });
			await writeFile(join(projectDir, 'partials', 'header.html'), '<header></header>');

			const { factory, getController } = createManualWatcherFactory();
			const previewCalls: RenderCall[] = [];
			const session = await start('receipt', {
				apiClient: makeStubClient({ previewCalls }),
				watcherFactory: factory,
			});
			expect(session.getState().activeTemplate).toBe('receipt');

			await writeFile(
				join(projectDir, 'partials', 'header.html'),
				'<header>changed</header>'
			);
			getController().emit(['partials/header.html']);

			await waitFor(() => previewCalls.length === 2, 're-render after the shared edit');
			// A shared partial names no single template — the view stays put.
			expect(session.getState().activeTemplate).toBe('receipt');
			expect(previewCalls[1].payload.template).toBe('receipt');
		});

		it('pin freezes the view so an unrelated save does not yank it away', async () => {
			await twoTemplates();
			const { factory, getController } = createManualWatcherFactory();
			const previewCalls: RenderCall[] = [];
			const session = await start(undefined, {
				apiClient: makeStubClient({ previewCalls }),
				watcherFactory: factory,
			});

			const pinned = await fetch(`${session.url}/api/pin?value=true`, { method: 'POST' });
			expect(((await pinned.json()) as DevState).pinned).toBe(true);

			await writeFile(
				join(projectDir, 'templates', 'receipt', 'receipt.html'),
				'<h1>receipt v2</h1>'
			);
			getController().emit(['templates/receipt/receipt.html']);

			await waitFor(() => previewCalls.length === 2, 're-render after the save');
			expect(session.getState().activeTemplate).toBe('invoice');
			expect(previewCalls[1].payload.template).toBe('invoice');

			// Unpinning restores the follow behaviour on the *next* change.
			await fetch(`${session.url}/api/pin?value=false`, { method: 'POST' });
			await writeFile(
				join(projectDir, 'templates', 'receipt', 'receipt.html'),
				'<h1>receipt v3</h1>'
			);
			getController().emit(['templates/receipt/receipt.html']);
			await waitFor(
				() => session.getState().activeTemplate === 'receipt',
				'the view to follow again once unpinned'
			);
		});
	});

	describe('error overlay', () => {
		it('surfaces a render failure, keeps the last good render and stays up', async () => {
			await setupTemplate(projectDir, 'invoice');
			let failNext = false;
			const { factory, getController } = createManualWatcherFactory();

			const session = await start(undefined, {
				apiClient: makeStubClient({
					previewImpl: async (payload) => {
						if (failNext) {
							throw new ApiError(
								'TEMPLATE_COMPILE_ERROR',
								422,
								'Unexpected token at templates/invoice/invoice.html:42:7'
							);
						}
						return {
							html: `<html><body>good ${String(payload.template)}</body></html>`,
							totalPages: 1,
							environment: 'sandbox' as const,
						};
					},
				}),
				watcherFactory: factory,
			});

			const goodVersion = session.getState().renderVersion;
			expect(goodVersion).toBe(1);

			failNext = true;
			await writeFile(
				join(projectDir, 'templates', 'invoice', 'invoice.html'),
				'<h1>{{ broken'
			);
			getController().emit(['templates/invoice/invoice.html']);

			await waitFor(() => session.getState().error !== null, 'the error overlay state');

			const state = session.getState();
			expect(state.error).toMatchObject({
				stage: 'render',
				file: 'templates/invoice/invoice.html',
				line: 42,
				column: 7,
			});
			expect(state.error!.message).toContain('Unexpected token');
			// Last good render survives behind the overlay.
			expect(state.renderVersion).toBe(goodVersion);
			expect(await (await fetch(`${session.url}/preview`)).text()).toContain('good invoice');

			// Recovering clears the overlay.
			failNext = false;
			getController().emit(['templates/invoice/invoice.html']);
			await waitFor(() => session.getState().error === null, 'the overlay to clear');
			expect(session.getState().renderVersion).toBe(goodVersion + 1);
		});

		it('keeps serving when the sync itself fails', async () => {
			await setupTemplate(projectDir, 'invoice');
			let failSync = false;
			const { factory, getController } = createManualWatcherFactory();

			const session = await start(undefined, {
				apiClient: makeStubClient({
					patchImpl: async () => {
						if (failSync) throw new ApiError('BAD_REQUEST', 400, 'draft rejected');
						return { syncedAt: '2026-09-01T10:00:00.000Z' };
					},
				}),
				watcherFactory: factory,
			});

			failSync = true;
			await writeFile(join(projectDir, 'templates', 'invoice', 'invoice.html'), 'x');
			getController().emit(['templates/invoice/invoice.html']);

			await waitFor(() => session.getState().error?.stage === 'sync', 'a sync error');
			expect(session.getState().error!.message).toContain('draft rejected');
			expect((await fetch(`${session.url}/state`)).status).toBe(200);
			expect((await fetch(session.url)).status).toBe(200);
		});
	});

	describe('render PDF', () => {
		it('renders the real PDF and serves it inline', async () => {
			await setupTemplate(projectDir, 'invoice');
			const pdfCalls: RenderCall[] = [];
			const pdfBytes = Buffer.from('%PDF-1.7\nreal pdf bytes');

			const session = await start(undefined, {
				apiClient: makeStubClient({ pdfCalls }),
				fetchPdf: async () => pdfBytes,
			});

			const response = await fetch(`${session.url}/api/pdf`, { method: 'POST' });
			expect(response.status).toBe(200);
			const body = (await response.json()) as { url: string };
			expect(body.url).toMatch(/^\/pdf\/\d+$/);
			expect(pdfCalls).toHaveLength(1);
			expect(pdfCalls[0].payload.template).toBe('invoice');

			const pdf = await fetch(`${session.url}${body.url}`);
			expect(pdf.status).toBe(200);
			expect(pdf.headers.get('content-type')).toBe('application/pdf');
			expect(Buffer.from(await pdf.arrayBuffer()).equals(pdfBytes)).toBe(true);
		});

		it('reports a failing PDF render without crashing the server', async () => {
			await setupTemplate(projectDir, 'invoice');
			const session = await start(undefined, {
				apiClient: makeStubClient(),
				fetchPdf: async () => {
					throw new Error('Failed to download PDF from presigned URL (HTTP 403).');
				},
			});

			const response = await fetch(`${session.url}/api/pdf`, { method: 'POST' });
			expect(response.status).toBe(502);
			expect((await response.json()) as { error: string }).toMatchObject({
				error: expect.stringContaining('HTTP 403'),
			});
			expect(session.getState().error?.stage).toBe('pdf');
			expect((await fetch(session.url)).status).toBe(200);
		});
	});

	describe('shutdown', () => {
		it('closes the watcher, the SSE clients and the port', async () => {
			await setupTemplate(projectDir, 'invoice');
			const { factory, getController } = createManualWatcherFactory();
			const session = await start(undefined, {
				apiClient: makeStubClient(),
				watcherFactory: factory,
			});
			const port = session.port;
			const sse = await openSse(session.url);

			await session.close();
			expect(getController().closed).toBe(true);

			// The port is free again — a fresh listener can take it.
			const reclaimed = createServer(() => {});
			extraServers.push(reclaimed);
			await new Promise<void>((resolve, reject) => {
				reclaimed.once('error', reject);
				reclaimed.listen(port, '127.0.0.1', () => resolve());
			});
			sse.close();
		});

		it('is idempotent', async () => {
			await setupTemplate(projectDir, 'invoice');
			const session = await start(undefined, { apiClient: makeStubClient() });
			await session.close();
			await expect(session.close()).resolves.toBeUndefined();
		});
	});

	describe('--data override', () => {
		it('sends the override payload instead of the template mock', async () => {
			await setupTemplate(projectDir, 'invoice', {
				mock: { locale: 'en', data: { title: 'From mock' } },
			});
			await writeFile(
				join(projectDir, 'custom.json'),
				JSON.stringify({ locale: 'fr', data: { title: 'From override' } })
			);

			const previewCalls: RenderCall[] = [];
			await start(undefined, {
				apiClient: makeStubClient({ previewCalls }),
				data: 'custom.json',
			});

			expect(previewCalls[0].payload.data).toEqual({ title: 'From override' });
			expect(previewCalls[0].payload.locale).toBe('fr');
		});
	});

	describe('manifest changes mid-session', () => {
		it('picks up a template added to the manifest', async () => {
			await setupTemplate(projectDir, 'invoice');
			const { factory, getController } = createManualWatcherFactory();
			const session = await start(undefined, {
				apiClient: makeStubClient(),
				watcherFactory: factory,
			});
			expect(session.getState().templates).toEqual(['invoice']);

			await setupTemplate(projectDir, 'receipt');
			getController().emit([MANIFEST_FILENAME]);

			await waitFor(
				() => session.getState().templates.length === 2,
				'the switcher to pick up the new template'
			);
			expect(session.getState().templates).toEqual(['invoice', 'receipt']);
		});

		it('falls back to another template when the active one disappears', async () => {
			await setupTemplate(projectDir, 'invoice');
			await setupTemplate(projectDir, 'receipt');
			const { factory, getController } = createManualWatcherFactory();
			const session = await start('receipt', {
				apiClient: makeStubClient(),
				watcherFactory: factory,
			});

			const manifest = await readManifest(projectDir);
			manifest.templates = manifest.templates!.filter((t) => t.name !== 'receipt');
			await writeManifest(projectDir, manifest);
			getController().emit([MANIFEST_FILENAME]);

			await waitFor(
				() => session.getState().activeTemplate === 'invoice',
				'a fallback to the remaining template'
			);
			expect((await fetch(`${session.url}/state`)).status).toBe(200);
		});

		it('survives a manifest that stops parsing', async () => {
			await setupTemplate(projectDir, 'invoice');
			const { factory, getController } = createManualWatcherFactory();
			const session = await start(undefined, {
				apiClient: makeStubClient(),
				watcherFactory: factory,
			});

			await writeFile(join(projectDir, MANIFEST_FILENAME), '{ not json');
			getController().emit([MANIFEST_FILENAME]);

			await waitFor(
				() => session.getState().error?.stage === 'project',
				'a project-level error'
			);
			expect((await fetch(session.url)).status).toBe(200);
			expect(session.getState().templates).toEqual(['invoice']);
		});
	});
});

describe('attributeChangedTemplate', () => {
	const names = ['invoice', 'receipt'];

	it('maps templates/<name>/<file> to <name>', () => {
		expect(attributeChangedTemplate('templates/invoice/invoice.html', names)).toBe('invoice');
		expect(attributeChangedTemplate('templates/receipt/data/rows.json', names)).toBe('receipt');
	});

	it('returns null for shared files that affect many templates', () => {
		expect(attributeChangedTemplate('tailwind.css', names)).toBeNull();
		expect(attributeChangedTemplate('partials/header.html', names)).toBeNull();
		expect(attributeChangedTemplate('assets/images/logo.svg', names)).toBeNull();
		expect(attributeChangedTemplate('poli-page.json', names)).toBeNull();
	});

	it('returns null for a directory that is not a declared template', () => {
		expect(attributeChangedTemplate('templates/orphan/orphan.html', names)).toBeNull();
	});
});

describe('pickFollowTarget', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'poli-follow-'));
		for (const name of ['a', 'b']) {
			await mkdir(join(dir, 'templates', name), { recursive: true });
			await writeFile(join(dir, 'templates', name, `${name}.html`), name);
		}
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('picks the template whose file has the newest mtime', async () => {
		const older = new Date(Date.now() - 60_000);
		await utimes(join(dir, 'templates', 'a', 'a.html'), older, older);

		const target = await pickFollowTarget(
			dir,
			['templates/a/a.html', 'templates/b/b.html'],
			['a', 'b']
		);
		expect(target).toBe('b');
	});

	it('returns null when only shared files changed', async () => {
		expect(await pickFollowTarget(dir, ['tailwind.css'], ['a', 'b'])).toBeNull();
		expect(await pickFollowTarget(dir, [], ['a', 'b'])).toBeNull();
	});

	it('still names a template whose file was deleted', async () => {
		expect(await pickFollowTarget(dir, ['templates/a/gone.html'], ['a', 'b'])).toBe('a');
	});
});

describe('extractErrorPosition', () => {
	it('reads file:line:column out of a message', () => {
		expect(
			extractErrorPosition('Unexpected token at templates/invoice/invoice.html:42:7')
		).toEqual({ file: 'templates/invoice/invoice.html', line: 42, column: 7 });
	});

	it('reads file:line when no column is present', () => {
		expect(extractErrorPosition('Parse error in tailwind.css:12')).toEqual({
			file: 'tailwind.css',
			line: 12,
		});
	});

	it('reads the prose form the engine sometimes emits', () => {
		expect(extractErrorPosition('Compile failed in invoice.html at line 8, column 3')).toEqual({
			file: 'invoice.html',
			line: 8,
			column: 3,
		});
	});

	it('returns nothing when the engine gives no position', () => {
		expect(extractErrorPosition('Cannot reach the API.')).toEqual({});
	});
});
