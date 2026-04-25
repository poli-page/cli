import { Command } from 'commander';
import { writeFile as writeFileAsync, mkdir as mkdirAsync } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadProject, findTemplate, loadTemplate } from '../project-loader.js';
import { getApiKey } from '../credentials.js';
import { createApiClient, type ApiClient } from '../api-client.js';

export interface RenderOptions {
	cwd?: string;
	output?: string;
	data?: string;
	live?: boolean;
	apiClient?: ApiClient;
	homeDir?: string;
}

export async function executeRender(
	templateName: string,
	options: RenderOptions = {}
): Promise<string> {
	const cwd = options.cwd ?? process.cwd();
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

	// Call API
	const pdfBuffer = await client.renderPdf(apiKey, {
		template: loaded.html,
		data,
		format: entry.format,
		orientation: entry.orientation,
	});

	// Write output
	const outputDir = join(projectDir, 'output');
	await mkdirAsync(outputDir, { recursive: true });
	const outputPath = options.output
		? resolve(cwd, options.output)
		: join(outputDir, `${templateName}.pdf`);
	await writeFileAsync(outputPath, pdfBuffer);

	return outputPath;
}

export function registerRenderCommand(program: Command) {
	program
		.command('render')
		.description('Render a PDF from a template')
		.argument('<name>', 'Template name')
		.option('-o, --output <path>', 'Output file path')
		.option('-d, --data <path>', 'JSON data file (overrides mock data)')
		.option('--live', 'Use live API key')
		.action(async (name: string, opts) => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');

			const spinner = ora(`Rendering ${name}...`).start();
			try {
				const outputPath = await executeRender(name, {
					output: opts.output,
					data: opts.data,
					live: opts.live,
				});
				spinner.succeed(chalk.green(`PDF rendered: ${outputPath}`));
			} catch (error) {
				spinner.fail(
					chalk.red(error instanceof Error ? error.message : 'Rendering failed')
				);
				process.exitCode = 1;
			}
		});
}
