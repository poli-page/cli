import { Command } from 'commander';
import { mkdir as mkdirAsync, writeFile as writeFileAsync } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadProject, findTemplate, loadTemplate } from '../project-loader.js';
import { getApiKey } from '../credentials.js';
import { createApiClient, type ApiClient } from '../api-client.js';

export interface ThumbnailOptions {
	cwd?: string;
	width: number;
	format?: 'png' | 'jpg';
	quality?: number;
	page?: number;
	all?: boolean;
	destinationFolder?: string;
	name?: string;
	data?: string;
	live?: boolean;
	apiClient?: ApiClient;
	homeDir?: string;
}

export interface ThumbnailResult {
	page: number;
	path: string;
	width: number;
	height: number;
}

export async function executeThumbnail(
	templateName: string,
	options: ThumbnailOptions
): Promise<ThumbnailResult[]> {
	const cwd = options.cwd ?? process.cwd();
	const format = options.format ?? 'png';
	const quality = options.quality ?? 95;
	const baseName = options.name ?? templateName;
	const client = options.apiClient ?? createApiClient();

	// Load project
	const { manifest, projectDir } = await loadProject(cwd);
	const entry = findTemplate(manifest, templateName);
	const loaded = await loadTemplate(projectDir, entry);

	// Verify project is linked
	if (!manifest.cloud) {
		throw new Error('Project is not linked to a cloud organization. Run "poli link" first.');
	}

	// Override data if --data flag provided
	let data = loaded.data;
	if (options.data) {
		const { readFile } = await import('node:fs/promises');
		const dataPath = resolve(cwd, options.data);
		const dataContent = await readFile(dataPath, 'utf-8');
		data = JSON.parse(dataContent);
	}

	// Get API key
	const environment = options.live ? 'live' : 'test';
	const apiKey = await getApiKey(manifest.cloud.orgSlug, environment, options.homeDir);

	// Determine which pages to request
	let pages: number[] | undefined;
	if (options.page) {
		pages = [options.page];
	} else if (!options.all) {
		pages = [1];
	}
	// undefined = all pages

	// Call API
	const thumbnailFormat = format === 'jpg' ? 'jpeg' : format;
	const thumbnails = await client.renderThumbnails(apiKey, {
		template: loaded.html,
		data,
		format: entry.format,
		orientation: entry.orientation,
		thumbnails: {
			width: options.width,
			quality,
			format: thumbnailFormat,
			pages,
		},
	});

	// Write output
	const outputDir = options.destinationFolder
		? resolve(cwd, options.destinationFolder)
		: join(projectDir, 'output');
	await mkdirAsync(outputDir, { recursive: true });

	const ext = format === 'jpg' ? 'jpg' : 'png';
	const results: ThumbnailResult[] = [];

	const fmtLabel = entry.format.toLowerCase();
	const oriLabel = entry.orientation.toLowerCase();

	for (const thumb of thumbnails) {
		const filename = `${baseName}-${options.width}px-${fmtLabel}-${oriLabel}-page-${thumb.page}.${ext}`;
		const filePath = join(outputDir, filename);
		await writeFileAsync(filePath, Buffer.from(thumb.data, 'base64'));
		results.push({
			page: thumb.page,
			path: filePath,
			width: thumb.width,
			height: thumb.height,
		});
	}

	return results;
}

export function registerThumbnailCommand(program: Command) {
	program
		.command('thumbnail')
		.description('Generate thumbnail images from a template')
		.argument('<name>', 'Template name')
		.requiredOption('-w, --width <px>', 'Thumbnail width in pixels', parseInt)
		.option('-f, --format <format>', 'Image format: png (default) or jpg', 'png')
		.option('-q, --quality <value>', 'JPEG quality 1-100 (default: 95)', parseInt)
		.option('-p, --page <number>', 'Generate only this page number', parseInt)
		.option('-a, --all', 'Generate thumbnails for all pages')
		.option('-d, --data <path>', 'JSON data file (overrides mock data)')
		.option('--destination-folder <path>', 'Output directory')
		.option('-n, --name <name>', 'Base name for output files')
		.option('--live', 'Use live API key')
		.action(async (name: string, opts) => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');

			const spinner = ora(`Generating thumbnail(s) for ${name}...`).start();
			try {
				const results = await executeThumbnail(name, {
					width: opts.width,
					format: opts.format,
					quality: opts.quality,
					page: opts.page,
					all: opts.all,
					data: opts.data,
					destinationFolder: opts.destinationFolder,
					name: opts.name,
					live: opts.live,
				});

				const summary = results
					.map((r) => `  ${r.width}×${r.height} → ${r.path}`)
					.join('\n');
				spinner.succeed(
					chalk.green(`${results.length} thumbnail(s) generated:\n${summary}`)
				);
			} catch (error) {
				spinner.fail(
					chalk.red(error instanceof Error ? error.message : 'Thumbnail generation failed')
				);
				process.exitCode = 1;
			}
		});
}
