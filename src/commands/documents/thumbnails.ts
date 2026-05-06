import { Command } from 'commander';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveAuth } from '../../auth.js';
import { readManifest } from '../../manifest.js';
import {
	createApiClient,
	type ApiClient,
	type DocumentThumbnailOptions,
} from '../../api-client.js';

export interface DocumentsThumbnailsOptions {
	cwd?: string;
	homeDir?: string;
	apiClient?: ApiClient;
	width?: number;
	format?: 'png' | 'jpeg';
	quality?: number;
	pages?: number[];
	output?: string;
}

export interface DocumentsThumbnailFile {
	page: number;
	path: string;
	width: number;
	height: number;
	contentType: string;
}

export async function executeDocumentsThumbnails(
	id: string,
	options: DocumentsThumbnailsOptions = {}
): Promise<DocumentsThumbnailFile[]> {
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

	const apiOptions: DocumentThumbnailOptions = {};
	if (options.width !== undefined) apiOptions.width = options.width;
	if (options.format !== undefined) apiOptions.format = options.format;
	if (options.quality !== undefined) apiOptions.quality = options.quality;
	if (options.pages !== undefined) apiOptions.pages = options.pages;

	const thumbnails = await client.documentThumbnails(
		auth.authorization,
		auth.orgIdHeader,
		id,
		apiOptions
	);

	const outputDir = options.output
		? resolve(cwd, options.output)
		: join(cwd, 'output', 'thumbnails', id);
	await mkdir(outputDir, { recursive: true });

	const results: DocumentsThumbnailFile[] = [];
	for (const thumb of thumbnails) {
		const ext = extensionForContentType(thumb.contentType);
		const filePath = join(outputDir, `page-${thumb.page}.${ext}`);
		await writeFile(filePath, Buffer.from(thumb.data, 'base64'));
		results.push({
			page: thumb.page,
			path: filePath,
			width: thumb.width,
			height: thumb.height,
			contentType: thumb.contentType,
		});
	}

	return results;
}

function extensionForContentType(contentType: string): string {
	if (contentType.includes('jpeg')) return 'jpeg';
	if (contentType.includes('jpg')) return 'jpg';
	return 'png';
}

function parsePages(value: string): number[] {
	return value
		.split(',')
		.map((s) => Number.parseInt(s.trim(), 10))
		.filter((n) => Number.isFinite(n) && n > 0);
}

export function registerDocumentsThumbnailsCommand(documents: Command): void {
	documents
		.command('thumbnails <id>')
		.description(
			'Regenerate thumbnails from a stored document (counts as a billable render on live keys)'
		)
		.option('-w, --width <px>', 'Thumbnail width in pixels', (v) => Number.parseInt(v, 10))
		.option('-f, --format <format>', 'png or jpeg (default jpeg)')
		.option('-q, --quality <n>', 'JPEG quality 1-100', (v) => Number.parseInt(v, 10))
		.option('--pages <list>', 'Comma-separated page numbers (e.g. "1,3")', parsePages)
		.option('-o, --output <dir>', 'Output directory')
		.option('--json', 'Output base64 thumbnails as JSON')
		.action(
			async (
				id: string,
				opts: {
					width?: number;
					format?: 'png' | 'jpeg';
					quality?: number;
					pages?: number[];
					output?: string;
					json?: boolean;
				}
			) => {
				const { default: chalk } = await import('chalk');
				const { default: ora } = await import('ora');

				const spinner = ora(`Generating thumbnails for ${id}…`).start();
				try {
					const results = await executeDocumentsThumbnails(id, {
						width: opts.width,
						format: opts.format,
						quality: opts.quality,
						pages: opts.pages,
						output: opts.output,
					});

					if (opts.json) {
						spinner.stop();
						console.log(JSON.stringify(results, null, 2));
						return;
					}

					const summary = results
						.map((r) => `  ${r.width}×${r.height} → ${r.path}`)
						.join('\n');
					spinner.succeed(
						chalk.green(
							`${results.length} thumbnail(s) generated:\n${summary}`
						)
					);
				} catch (err) {
					spinner.fail(
						chalk.red(
							err instanceof Error ? err.message : 'Thumbnails failed'
						)
					);
					process.exitCode = 1;
				}
			}
		);
}
