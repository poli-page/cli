import { Command } from 'commander';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { resolveAuth } from '../../auth.js';
import { readManifest } from '../../manifest.js';
import { createApiClient, type ApiClient } from '../../api-client.js';
import { errorToExitCode } from '../../exit-codes.js';
import { shouldEmitJson } from '../../output.js';

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

	let manifestOrgId: string | undefined;
	try {
		const manifest = await readManifest(cwd);
		manifestOrgId = manifest.cloud?.orgId;
	} catch {
		// Not in a project — leave undefined.
	}

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

	const outputPath = options.output
		? resolve(cwd, options.output)
		: join(cwd, 'output', 'documents', `${id}.preview.html`);
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, html, 'utf-8');

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
