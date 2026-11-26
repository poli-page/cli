import { Command } from 'commander';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { resolveAuth } from '../../auth.js';
import { readCloudLink } from '../../manifest.js';
import { createApiClient, type ApiClient } from '../../api-client.js';
import { errorToExitCode } from '../../exit-codes.js';
import { shouldEmitJson } from '../../output.js';
import { safeWriteFile } from '../../security/paths.js';
import { assertDocumentId } from './document-id.js';

const PREVIEW_CSP =
	"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";

// DNS prefetch is outside CSP, so the second meta turns it off for hyperlinks;
// browsers do not apply it to a <link rel="dns-prefetch">, which can still leak
// data in a hostname.
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta http-equiv="x-dns-prefetch-control" content="off">`;

// What a browser parses before it opens <head>: comments (including the
// `<!-->` and `--!>` forms), the doctype and the other `<!...>` and `<?...>`
// bogus comments (an XML prolog), and HTML whitespace (not \s: a non-breaking
// space is text and opens <body>).
const BEFORE_HEAD_TOKEN = /<!--(?:>|->|[\s\S]*?--!?>)|<!(?!--)[^>]*>|<\?[^>]*>|[\t\n\f\r ]+/y;

const isTagSpace = (c: string) => '\t\n\f\r '.includes(c);

// Index just past the `<name ...>` start tag at `at`, or -1. Follows the HTML
// tokenizer's attribute states: only a quote that opens a value quotes, so
// `<head a'>` ends at its first `>`, and `<head-x>` is another element.
function startTagEnd(html: string, at: number, name: string): number {
	let i = at + name.length + 1;
	if (html.slice(at, i).toLowerCase() !== `<${name}`) return -1;
	if (i < html.length && !isTagSpace(html[i]) && html[i] !== '/' && html[i] !== '>') {
		return -1;
	}
	while (i < html.length) {
		const c = html[i];
		if (c === '>') return i + 1;
		if (isTagSpace(c) || c === '/') {
			i++;
			continue;
		}
		i++; // an attribute name may start with `=`
		while (i < html.length && !isTagSpace(html[i]) && !'/>='.includes(html[i])) i++;
		while (i < html.length && isTagSpace(html[i])) i++;
		if (html[i] !== '=') continue;
		i++;
		while (i < html.length && isTagSpace(html[i])) i++;
		const quote = html[i];
		if (quote === '"' || quote === "'") {
			const close = html.indexOf(quote, i + 1);
			if (close === -1) return -1;
			i = close + 1;
		} else {
			while (i < html.length && !isTagSpace(html[i]) && html[i] !== '>') i++;
		}
	}
	return -1;
}

// The preview is opened as file://, so its template markup and customer data
// must not load, run or submit anything (a meta refresh still navigates: CSP
// cannot block it). Anything past the point where the browser
// opens <head> would already run before a meta placed later.
export function injectPreviewCsp(html: string): string {
	let at = html.startsWith('\uFEFF') ? 1 : 0;
	for (;;) {
		BEFORE_HEAD_TOKEN.lastIndex = at;
		const token = BEFORE_HEAD_TOKEN.exec(html);
		const end = token ? at + token[0].length : startTagEnd(html, at, 'html');
		if (end === -1) break;
		at = end;
	}
	const end = startTagEnd(html, at, 'head');
	if (end !== -1) {
		return html.slice(0, end) + CSP_META + html.slice(end);
	}
	return html.slice(0, at) + `<head>${CSP_META}</head>` + html.slice(at);
}

export interface DocumentsPreviewOptions {
	cwd?: string;
	homeDir?: string;
	apiClient?: ApiClient;
	output?: string;
	noOpen?: boolean;
	json?: boolean;
	openFn?: (path: string) => Promise<void>;
}

export interface DocumentsPreviewResult {
	html: string;
	pageCount: number;
	path?: string;
}

export async function executeDocumentsPreview(
	id: string,
	options: DocumentsPreviewOptions = {}
): Promise<DocumentsPreviewResult> {
	const cwd = options.cwd ?? process.cwd();
	assertDocumentId(id);

	const manifestOrgId = (await readCloudLink(cwd))?.orgId;

	let auth;
	try {
		auth = await resolveAuth({ manifestOrgId, homeDir: options.homeDir });
	} catch (err) {
		if (err instanceof Error && /isn't linked/i.test(err.message)) {
			throw new Error(
				'Run this command inside a linked project, or set POLI_PAGE_API_KEY for api-key mode.'
			);
		}
		throw err;
	}

	const client = options.apiClient ?? createApiClient();
	const { html, pageCount } = await client.documentPreview(
		auth.authorization,
		auth.orgIdHeader,
		id
	);

	if (options.json) {
		return { html, pageCount };
	}

	const content = injectPreviewCsp(html);
	let outputPath: string;
	if (options.output) {
		outputPath = resolve(cwd, options.output);
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, content, 'utf-8');
	} else {
		const rel = join('output', 'documents', `${id}.preview.html`);
		outputPath = await safeWriteFile(cwd, rel, content);
	}

	if (!options.noOpen && options.openFn) {
		await options.openFn(outputPath);
	}

	return { html, pageCount, path: outputPath };
}

export function registerDocumentsPreviewCommand(documents: Command): void {
	documents
		.command('preview <id>')
		.description('Fetch a document preview HTML (free, no quota cost)')
		.option('-o, --output <file>', 'Write HTML to this path')
		.option('--no-open', 'Do not open the HTML in a browser')
		.option('--json', 'Force JSON output even in a TTY')
		.action(
			async (
				id: string,
				opts: { output?: string; open?: boolean; json?: boolean }
			) => {
				const { default: chalk } = await import('chalk');
				try {
					const emitJson = shouldEmitJson(opts);
					const result = await executeDocumentsPreview(id, {
						output: opts.output,
						noOpen: opts.open === false,
						// `executeDocumentsPreview` writes the HTML file unless
						// `json` is true. In auto-JSON mode (pipe), no file —
						// scripts get pure stdout.
						json: emitJson,
						openFn: async (path) => {
							const open = await import('open');
							await open.default(path);
						},
					});

					if (emitJson) {
						console.log(
							JSON.stringify(
								{ html: result.html, totalPages: result.pageCount },
								null,
								2
							)
						);
						return;
					}

					console.log(
						chalk.green(
							`✓ Preview written to ${result.path} (${result.pageCount} page${result.pageCount === 1 ? '' : 's'})`
						)
					);
				} catch (err) {
					console.error(
						chalk.red(err instanceof Error ? err.message : 'Preview failed')
					);
					process.exitCode = errorToExitCode(err);
				}
			}
		);
}
