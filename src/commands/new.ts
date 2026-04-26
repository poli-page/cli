import { Command } from 'commander';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest, writeManifest } from '../manifest.js';
import { DEFAULT_FORMAT, DEFAULT_ORIENTATION, MANIFEST_FILENAME } from '../constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function toKebabCase(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function getTemplatesDir(): string {
	// Navigate from src/commands/ (or dist/commands/) up to repo root, then into templates/
	return join(__dirname, '..', '..', 'templates');
}

export function getAvailableModels(): string[] {
	return [
		'blank',
		'header-main-footer',
		'header-main-footer-sidebar',
		'header-main-sidebar-footer',
		'header-sidebar-main-footer',
		'sidebar-header-main-footer',
	];
}

async function loadStructureFiles(
	model: string
): Promise<{ html: string; json: string }> {
	const models = getAvailableModels();
	if (!models.includes(model)) {
		throw new Error(
			`Unknown model "${model}". Available: ${models.join(', ')}`
		);
	}

	const templateDir = join(getTemplatesDir(), model);
	const htmlPath = join(templateDir, `${model}.html`);
	const jsonPath = join(templateDir, `${model}.json`);

	const html = await readFile(htmlPath, 'utf-8');
	const json = await readFile(jsonPath, 'utf-8');

	return { html, json };
}

export interface NewOptions {
	cwd?: string;
	format?: string;
	orientation?: string;
	model?: string;
}

export async function executeNew(name: string, options: NewOptions = {}): Promise<string> {
	const cwd = options.cwd ?? process.cwd();
	const templateName = toKebabCase(name);
	const format = options.format ?? DEFAULT_FORMAT;
	const orientation = options.orientation ?? DEFAULT_ORIENTATION;
	const model = options.model ?? 'header-main-footer';

	// Verify we're in a Poli Page project
	let manifest;
	try {
		manifest = await readManifest(cwd);
	} catch {
		throw new Error(
			`No ${MANIFEST_FILENAME} found in ${cwd}. Run "poli init" first.`
		);
	}

	// Check duplicate
	const existing = manifest.templates?.find((t) => t.name === templateName);
	if (existing) {
		throw new Error(`Template "${templateName}" already exists in ${MANIFEST_FILENAME}.`);
	}

	// Load structure files
	const structure = await loadStructureFiles(model);

	// Create template directory and files
	const templateDir = join(cwd, 'templates', templateName);
	await mkdir(templateDir, { recursive: true });

	const htmlFilename = `${templateName}.html`;
	const mockFilename = `${templateName}.json`;

	await writeFile(join(templateDir, htmlFilename), structure.html, 'utf-8');
	await writeFile(join(templateDir, mockFilename), structure.json, 'utf-8');

	// Update manifest
	if (!manifest.templates) {
		manifest.templates = [];
	}
	manifest.templates.push({
		name: templateName,
		template: htmlFilename,
		mock: mockFilename,
		format,
		orientation,
	});

	await writeManifest(cwd, manifest);

	return templateDir;
}

export function registerNewCommand(program: Command) {
	const models = getAvailableModels();

	program
		.command('new')
		.description('Create a new template from a model')
		.argument('<name>', 'Template name')
		.option(
			'--model <model>',
			`Template model (${models.join(', ')})`,
			'header-main-footer'
		)
		.option(
			'--format <format>',
			'Page format (A3, A4, A5, A6, B4, B5, Letter, Legal, Tabloid, Executive, Statement, Folio)',
			DEFAULT_FORMAT,
		)
		.option('--orientation <orientation>', 'Page orientation (portrait, landscape)', DEFAULT_ORIENTATION)
		.action(async (name: string, opts) => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');

			const spinner = ora('Creating template...').start();
			try {
				const templateDir = await executeNew(name, {
					format: opts.format,
					orientation: opts.orientation,
					model: opts.model,
				});
				spinner.succeed(chalk.green(`Template created at ${templateDir}`));
				console.log();
				console.log(`  ${chalk.bold('Next steps:')}`);
				console.log(`  ${chalk.cyan(`Edit templates/${toKebabCase(name)}/${toKebabCase(name)}.html`)}`);
				console.log(`  ${chalk.cyan(`poli render ${toKebabCase(name)}`)}  — generate PDF`);
				console.log();
			} catch (error) {
				spinner.fail(
					chalk.red(error instanceof Error ? error.message : 'Failed to create template')
				);
				process.exitCode = 1;
			}
		});
}
