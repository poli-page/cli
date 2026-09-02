import { Command } from 'commander';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ServerResponse } from 'node:http';
import { SystemProjectLockedError, type ApiClient, type PreviewApiResult } from '../api-client.js';
import { resolveCloudContext } from '../cloud-context.js';
import { createFileWatcher, type FileWatcher, type FileWatcherOptions } from '../file-watcher.js';
import { createProjectSyncer } from '../project-sync.js';
import {
	findTemplate,
	loadProject,
	loadTemplate,
	unwrapMockJson,
	type TemplateEntry,
} from '../project-loader.js';
import type { PoliPageManifest } from '../manifest.js';
import { resolveAuth, type AuthContext } from '../auth.js';
import { errorToExitCode } from '../exit-codes.js';
import {
	startDevServer,
	DEFAULT_DEV_PORT,
	type DevServer,
	type DevServerRequest,
} from '../dev-server.js';
import { DEV_PAGE_HTML, DEV_PLACEHOLDER_HTML } from '../dev-page.js';
import { SYSTEM_PROJECT_FRIENDLY } from './watch.js';

const DEFAULT_DEBOUNCE_MS = 300;
const PDF_CACHE_LIMIT = 4;

export type DevEventType =
	'ready' | 'syncing' | 'synced' | 'rendering' | 'rendered' | 'pdf' | 'error' | 'stopped';

export interface DevEvent {
	type: DevEventType;
	message?: string;
	template?: string;
}

export type DevStatus = 'idle' | 'syncing' | 'rendering';

export interface DevError {
	/** Which step produced it — the overlay titles itself from this. */
	stage: 'sync' | 'render' | 'pdf' | 'project';
	message: string;
	file?: string;
	line?: number;
	column?: number;
}

/** The snapshot handed to the browser on `/state` and over SSE. */
export interface DevState {
	templates: string[];
	activeTemplate: string | null;
	pinned: boolean;
	status: DevStatus;
	/** Bumped on every successful render — the browser's reload trigger. */
	renderVersion: number;
	pageCount: number;
	error: DevError | null;
	lastRenderedAt: string | null;
}

export interface DevOptions {
	cwd?: string;
	homeDir?: string;
	apiClient?: ApiClient;
	port?: number;
	maxPortAttempts?: number;
	/** Open the browser on start. Defaults to true. */
	open?: boolean;
	/** `-d, --data <path>` — overrides every template's mock, like `poli preview`. */
	data?: string;
	signal?: AbortSignal;
	watcherFactory?: (options: FileWatcherOptions) => FileWatcher;
	debounceMs?: number;
	onEvent?: (event: DevEvent) => void;
	/** Injectable for tests — defaults to the `open` package. */
	openFn?: (url: string) => Promise<unknown>;
	/** Injectable for tests — defaults to fetching the presigned URL. */
	fetchPdf?: (url: string) => Promise<Buffer>;
}

export interface DevSession {
	readonly url: string;
	readonly port: number;
	getState(): DevState;
	/** Resolves once the in-flight sync/render work has settled. */
	close(): Promise<void>;
}

/**
 * A `templates/<name>/…` path belongs to `<name>`. Anything else — a
 * shared partial, `tailwind.css`, an asset, the manifest — belongs to no
 * single template, so it cannot move the follow target.
 */
export function attributeChangedTemplate(
	changedPath: string,
	templateNames: readonly string[]
): string | null {
	const segments = changedPath.split('/');
	if (segments.length < 3) return null;
	if (segments[0] !== 'templates') return null;
	const name = segments[1];
	return templateNames.includes(name) ? name : null;
}

/**
 * Decide which template the view should follow after a sync.
 *
 * "Most recently changed" is resolved per *template-owned* file: only
 * paths under `templates/<name>/` name a template. A batch that touches
 * several of them picks the one whose file has the newest mtime (ties
 * broken alphabetically, so the answer is deterministic).
 *
 * Editing a shared partial, `tailwind.css`, an asset, or the manifest
 * changes many templates at once and therefore names none: the function
 * returns `null`, meaning "keep whatever is on screen and re-render it".
 * That is the honest reading — a shared edit has no single owner, and
 * yanking the user to an arbitrary template would be worse than staying.
 */
export async function pickFollowTarget(
	cwd: string,
	changedPaths: readonly string[],
	templateNames: readonly string[]
): Promise<string | null> {
	const newest = new Map<string, number>();

	for (const changedPath of changedPaths) {
		const template = attributeChangedTemplate(changedPath, templateNames);
		if (!template) continue;
		let mtime = 0;
		try {
			mtime = (await stat(join(cwd, changedPath))).mtimeMs;
		} catch {
			// Deleted between the sync and this stat — it still counts as a
			// change, just without a usable timestamp.
			mtime = 0;
		}
		const current = newest.get(template);
		if (current === undefined || mtime > current) {
			newest.set(template, mtime);
		}
	}

	if (newest.size === 0) return null;

	return [...newest.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

const POSITION_PATTERNS: RegExp[] = [
	// `templates/invoice/invoice.html:42:7`
	/([\w./\\-]+\.(?:html|css|json)):(\d+)(?::(\d+))?/i,
	// `… in invoice.html at line 42, column 7`
	/(?:in|at)\s+([\w./\\-]+\.(?:html|css|json))\D+line\s+(\d+)(?:\D+column\s+(\d+))?/i,
];

/**
 * Pull a `file:line[:column]` out of an engine error message when the
 * engine bothered to include one. The message is always shown verbatim —
 * this only enriches the overlay header, never replaces the text.
 */
export function extractErrorPosition(message: string): {
	file?: string;
	line?: number;
	column?: number;
} {
	for (const pattern of POSITION_PATTERNS) {
		const match = pattern.exec(message);
		if (!match) continue;
		const line = Number.parseInt(match[2], 10);
		const column = match[3] ? Number.parseInt(match[3], 10) : undefined;
		return {
			file: match[1],
			...(Number.isFinite(line) ? { line } : {}),
			...(column !== undefined && Number.isFinite(column) ? { column } : {}),
		};
	}
	return {};
}

function toDevError(stage: DevError['stage'], err: unknown): DevError {
	const message = err instanceof Error ? err.message : String(err);
	return { stage, message, ...extractErrorPosition(message) };
}

interface PdfCacheEntry {
	id: number;
	template: string;
	buffer: Buffer;
}

/**
 * Start the `poli dev` loop and its local server.
 *
 * Deliberately does **not** require a TTY: `poli dev` is a server meant
 * to be composed into a user's own dev script (`concurrently`, `npm-run-all`,
 * a Procfile), all of which pipe child stdout.
 */
export async function startDevSession(
	templateName: string | undefined,
	options: DevOptions = {}
): Promise<DevSession> {
	const cwd = options.cwd ?? process.cwd();
	const emit = (event: DevEvent) => options.onEvent?.(event);

	// Resolves the manifest, the session token and the org — throws the
	// familiar "not linked" / "not logged in" errors before anything is
	// served, so a misconfigured project fails fast instead of booting a
	// server that can never work.
	const { client, ctx } = await resolveCloudContext({
		cwd,
		apiClient: options.apiClient,
		homeDir: options.homeDir,
	});

	const initial = await loadProject(cwd);
	let manifest: PoliPageManifest = initial.manifest;
	let templates = templateNamesOf(manifest);

	if (templateName !== undefined) {
		// Fail fast on an unknown name given on the command line — same
		// message (and exit code) as `poli render` / `poli preview`.
		findTemplate(manifest, templateName);
	}

	const auth: AuthContext = await resolveAuth({
		manifestOrgId: manifest.cloud?.orgId ?? ctx.orgId,
		homeDir: options.homeDir,
	});

	const state: DevState = {
		templates,
		// The positional argument only chooses the *initial* view. It does
		// not pin — the documented default stays "follow the most recently
		// changed template" until the user clicks Pin.
		activeTemplate: templateName ?? templates[0] ?? null,
		pinned: false,
		status: 'idle',
		renderVersion: 0,
		pageCount: 0,
		error: null,
		lastRenderedAt: null,
	};

	if (templates.length === 0) {
		state.error = {
			stage: 'project',
			message: `No templates declared in poli-page.json. Add one with \`poli new <name>\`.`,
		};
	}

	let lastGoodHtml: string | null = null;
	let renderSeq = 0;
	let pdfSeq = 0;
	const pdfCache: PdfCacheEntry[] = [];
	let server: DevServer | null = null;
	let stopped = false;

	function broadcast(): void {
		server?.broadcast('state', state);
	}

	function setStatus(next: DevStatus): void {
		state.status = next;
		broadcast();
	}

	const syncer = createProjectSyncer({ cwd, client, ctx, signal: options.signal });

	/**
	 * Re-read the manifest so templates added, renamed or removed during
	 * the session show up in the switcher. A broken manifest surfaces in
	 * the overlay and leaves the previous list in place.
	 */
	async function refreshManifest(): Promise<boolean> {
		try {
			const loaded = await loadProject(cwd);
			manifest = loaded.manifest;
			templates = templateNamesOf(manifest);
			state.templates = templates;
			if (state.activeTemplate && !templates.includes(state.activeTemplate)) {
				const gone = state.activeTemplate;
				state.activeTemplate = templates[0] ?? null;
				const message = state.activeTemplate
					? `Template "${gone}" is gone from poli-page.json — switched to "${state.activeTemplate}".`
					: `Template "${gone}" is gone from poli-page.json and none is left.`;
				state.error = { stage: 'project', message };
				emit({ type: 'error', message });
			}
			return true;
		} catch (err) {
			state.error = toDevError('project', err);
			return false;
		}
	}

	async function resolveRenderInput(
		template: string
	): Promise<{ entry: TemplateEntry; data: Record<string, unknown>; locale?: string }> {
		const entry = findTemplate(manifest, template);
		const loaded = await loadTemplate(cwd, entry);
		if (!options.data) {
			return { entry, data: loaded.data, locale: loaded.locale };
		}
		// Re-read on every render so edits to the override file are picked
		// up without restarting the server.
		const dataPath = resolve(cwd, options.data);
		const raw = JSON.parse(await readFile(dataPath, 'utf-8')) as Record<string, unknown>;
		const unwrapped = unwrapMockJson(raw);
		return { entry, data: unwrapped.data, locale: unwrapped.locale };
	}

	function previewPayload(
		entry: TemplateEntry,
		data: Record<string, unknown>,
		locale: string | undefined
	): Record<string, unknown> {
		return {
			project: manifest.cloud?.projectSlug,
			template: entry.name,
			version: 'draft',
			data,
			format: entry.format,
			orientation: entry.orientation,
			...(locale ? { locale } : {}),
		};
	}

	async function render(): Promise<void> {
		const template = state.activeTemplate;
		if (!template) {
			setStatus('idle');
			return;
		}

		const seq = ++renderSeq;
		setStatus('rendering');
		emit({ type: 'rendering', template });

		try {
			const { entry, data, locale } = await resolveRenderInput(template);
			const result: PreviewApiResult = await client.renderPreview(
				auth.authorization,
				auth.orgIdHeader,
				previewPayload(entry, data, locale)
			);
			// A newer render was requested while this one was in flight —
			// drop the stale result rather than flashing it on screen.
			if (seq !== renderSeq) return;
			lastGoodHtml = result.html;
			state.pageCount = result.totalPages;
			state.renderVersion += 1;
			state.lastRenderedAt = new Date().toISOString();
			state.error = null;
			emit({
				type: 'rendered',
				template,
				message: `${result.totalPages} page${result.totalPages === 1 ? '' : 's'}`,
			});
		} catch (err) {
			if (seq !== renderSeq) return;
			// The last good render stays on screen behind the overlay.
			state.error = toDevError('render', err);
			emit({ type: 'error', template, message: state.error.message });
		} finally {
			if (seq === renderSeq) setStatus('idle');
		}
	}

	async function renderPdf(): Promise<{ url: string } | { error: string }> {
		const template = state.activeTemplate;
		if (!template) return { error: 'No template selected.' };

		try {
			const { entry, data, locale } = await resolveRenderInput(template);
			const descriptor = await client.render(
				auth.authorization,
				auth.orgIdHeader,
				previewPayload(entry, data, locale)
			);
			const buffer = options.fetchPdf
				? await options.fetchPdf(descriptor.presignedPdfUrl)
				: await defaultFetchPdf(descriptor.presignedPdfUrl);

			const id = ++pdfSeq;
			pdfCache.push({ id, template, buffer });
			while (pdfCache.length > PDF_CACHE_LIMIT) pdfCache.shift();

			state.error = null;
			emit({ type: 'pdf', template, message: `${descriptor.pageCount} page(s)` });
			broadcast();
			return { url: `/pdf/${id}` };
		} catch (err) {
			state.error = toDevError('pdf', err);
			emit({ type: 'error', template, message: state.error.message });
			broadcast();
			return { error: state.error.message };
		}
	}

	async function onBatch(): Promise<void> {
		if (stopped || options.signal?.aborted) return;
		try {
			setStatus('syncing');
			emit({ type: 'syncing' });
			const outcome = await syncer.sync();

			if (!(await refreshManifest())) {
				setStatus('idle');
				return;
			}

			if (outcome.changed) {
				emit({ type: 'synced', message: `${outcome.changedPaths.length} file(s)` });
				if (!state.pinned) {
					const target = await pickFollowTarget(cwd, outcome.changedPaths, templates);
					if (target) state.activeTemplate = target;
				}
			}

			// Render on the sync-completed event — never on a timer. Even a
			// "no changes" batch re-renders: the draft is known good and the
			// user asked for feedback.
			await render();
		} catch (err) {
			if (options.signal?.aborted) return;
			if (err instanceof SystemProjectLockedError) {
				// Permanent for this project — keep serving so the message
				// stays visible, but stop hammering the API on every save.
				state.error = { stage: 'sync', message: SYSTEM_PROJECT_FRIENDLY };
				stopped = true;
				emit({ type: 'error', message: SYSTEM_PROJECT_FRIENDLY });
				setStatus('idle');
				return;
			}
			state.error = toDevError('sync', err);
			emit({ type: 'error', message: state.error.message });
			setStatus('idle');
		}
	}

	async function handleRequest(request: DevServerRequest): Promise<void> {
		const { method, pathname, query, res } = request;

		if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
			sendHtml(res, DEV_PAGE_HTML);
			return;
		}

		if (method === 'GET' && pathname === '/preview') {
			sendHtml(res, lastGoodHtml ?? DEV_PLACEHOLDER_HTML);
			return;
		}

		if (method === 'GET' && pathname === '/state') {
			sendJson(res, 200, state);
			return;
		}

		if (method === 'POST' && pathname === '/api/select') {
			const requested = query.get('template');
			if (!requested || !templates.includes(requested)) {
				state.error = {
					stage: 'project',
					message: `Template "${requested ?? ''}" is not in poli-page.json.`,
				};
				sendJson(res, 404, state);
				broadcast();
				return;
			}
			if (requested !== state.activeTemplate) {
				state.activeTemplate = requested;
				state.error = null;
				sendJson(res, 200, state);
				broadcast();
				await render();
				return;
			}
			sendJson(res, 200, state);
			return;
		}

		if (method === 'POST' && pathname === '/api/pin') {
			state.pinned = query.get('value') !== 'false';
			sendJson(res, 200, state);
			broadcast();
			return;
		}

		if (method === 'POST' && pathname === '/api/pdf') {
			const result = await renderPdf();
			sendJson(res, 'error' in result ? 502 : 200, result);
			return;
		}

		if (method === 'GET' && pathname.startsWith('/pdf/')) {
			const id = Number.parseInt(pathname.slice('/pdf/'.length), 10);
			const entry = pdfCache.find((candidate) => candidate.id === id);
			if (!entry) {
				sendJson(res, 404, { error: 'That PDF is no longer cached — render it again.' });
				return;
			}
			res.writeHead(200, {
				'Content-Type': 'application/pdf',
				'Content-Length': String(entry.buffer.byteLength),
				'Content-Disposition': `inline; filename="${encodeURIComponent(entry.template)}.pdf"`,
				'Cache-Control': 'no-store',
			});
			res.end(entry.buffer);
			return;
		}

		sendJson(res, 404, { error: `No route for ${method} ${pathname}` });
	}

	// The server comes up before the first render so the URL is printable
	// (and the browser openable) immediately: the page shows its
	// placeholder and follows the first sync/render live over SSE.
	server = await startDevServer({
		port: options.port ?? DEFAULT_DEV_PORT,
		maxPortAttempts: options.maxPortAttempts,
		handleRequest,
	});

	emit({
		type: 'ready',
		message: server.url,
		...(state.activeTemplate ? { template: state.activeTemplate } : {}),
	});

	if (options.open !== false) {
		const opener = options.openFn ?? defaultOpen;
		try {
			await opener(server.url);
		} catch {
			// No browser available (headless box, container, CI) — the URL
			// is already printed, so this is not worth failing over.
		}
	}

	// Snapshot the tree, then push all of it so the cloud draft matches
	// the working copy before the very first render. Without it, run #1
	// would render whatever the draft happened to contain.
	await syncer.prime();
	try {
		setStatus('syncing');
		emit({ type: 'syncing' });
		await syncer.syncAll();
	} catch (err) {
		if (err instanceof SystemProjectLockedError) {
			state.error = { stage: 'sync', message: SYSTEM_PROJECT_FRIENDLY };
			stopped = true;
			emit({ type: 'error', message: SYSTEM_PROJECT_FRIENDLY });
		} else {
			state.error = toDevError('sync', err);
			emit({ type: 'error', message: state.error.message });
		}
	}
	state.status = 'idle';

	if (!stopped) {
		await render();
	}

	// Only now start watching: a batch arriving mid-bootstrap would race
	// the initial full sync.
	const watcher = (options.watcherFactory ?? createFileWatcher)({
		cwd,
		debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
		onBatch: () => {
			void onBatch();
		},
	});

	let closing: Promise<void> | null = null;
	const close = async (): Promise<void> => {
		if (closing) return closing;
		stopped = true;
		closing = (async () => {
			await watcher.close();
			await server?.close();
			emit({ type: 'stopped' });
		})();
		return closing;
	};

	if (options.signal) {
		if (options.signal.aborted) {
			await close();
		} else {
			options.signal.addEventListener('abort', () => void close(), { once: true });
		}
	}

	return {
		url: server.url,
		port: server.port,
		getState: () => ({ ...state, templates: [...state.templates] }),
		close,
	};
}

/** Start the session and stay up until the abort signal fires. */
export async function executeDev(
	templateName: string | undefined,
	options: DevOptions = {}
): Promise<void> {
	const session = await startDevSession(templateName, options);

	await new Promise<void>((done) => {
		// No signal → the server runs until the process itself is killed.
		// The CLI action always supplies one (SIGINT / SIGTERM).
		if (!options.signal) return;
		if (options.signal.aborted) {
			done();
			return;
		}
		options.signal.addEventListener('abort', () => done(), { once: true });
	});

	await session.close();
}

function templateNamesOf(manifest: PoliPageManifest): string[] {
	return (manifest.templates ?? []).map((entry) => entry.name);
}

function sendHtml(res: ServerResponse, html: string): void {
	res.writeHead(200, {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store',
	});
	res.end(html);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
	});
	res.end(JSON.stringify(payload));
}

async function defaultOpen(url: string): Promise<unknown> {
	const open = await import('open');
	return open.default(url);
}

async function defaultFetchPdf(url: string): Promise<Buffer> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download PDF from presigned URL (HTTP ${response.status}).`);
	}
	return Buffer.from(await response.arrayBuffer());
}

export function parsePort(raw: string): number {
	const port = Number.parseInt(raw, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		const error = new Error(
			`Invalid --port "${raw}": expected an integer between 1 and 65535.`
		);
		Object.assign(error, { exitCode: 2 });
		throw error;
	}
	return port;
}

export function registerDevCommand(program: Command): void {
	program
		.command('dev')
		.description(
			'Serve a live-reloading preview of a template: sync on save, re-render, push to the browser'
		)
		.argument('[template]', 'Template to show first (defaults to the first in the manifest)')
		.option('-p, --port <n>', `Port to listen on (default: ${DEFAULT_DEV_PORT})`)
		.option('-d, --data <path>', 'JSON data file (overrides the template mock)')
		.option('--no-open', 'Do not open the browser on start')
		.action(async (template: string | undefined, opts) => {
			const { default: chalk } = await import('chalk');
			const controller = new AbortController();
			const stop = () => controller.abort();
			process.on('SIGINT', stop);
			process.on('SIGTERM', stop);

			try {
				await executeDev(template, {
					signal: controller.signal,
					port: opts.port ? parsePort(opts.port) : undefined,
					data: opts.data,
					open: opts.open !== false,
					// Line-oriented, never carriage-return overwrites: the
					// output has to stay readable when piped through
					// `concurrently` or captured in a log file.
					onEvent: (event) => {
						const ts = new Date().toLocaleTimeString();
						switch (event.type) {
							case 'ready':
								console.log(
									chalk.cyan(`▸ poli dev — ${event.message ?? ''}`) +
										(event.template ? chalk.dim(` (${event.template})`) : '')
								);
								console.log(
									chalk.dim('  Save a file to re-render. Ctrl-C to stop.')
								);
								break;
							case 'syncing':
								console.log(chalk.dim(`[${ts}] syncing...`));
								break;
							case 'rendered':
								console.log(
									chalk.green(
										`[${ts}] ✓ rendered ${event.template ?? ''}${event.message ? ` — ${event.message}` : ''}`
									)
								);
								break;
							case 'pdf':
								console.log(
									chalk.green(
										`[${ts}] ✓ PDF ready for ${event.template ?? ''}${event.message ? ` — ${event.message}` : ''}`
									)
								);
								break;
							case 'error':
								console.error(chalk.red(`[${ts}] ✗ ${event.message ?? 'error'}`));
								break;
							case 'stopped':
								console.log(chalk.dim('Dev server stopped.'));
								break;
						}
					},
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Dev server failed';
				console.error(chalk.red(message));
				process.exitCode = errorToExitCode(err);
			} finally {
				process.removeListener('SIGINT', stop);
				process.removeListener('SIGTERM', stop);
			}
		});
}
