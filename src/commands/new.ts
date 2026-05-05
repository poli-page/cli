import { Command } from 'commander';
import { readManifest, writeManifest } from '../manifest.js';
import { MANIFEST_FILENAME } from '../constants.js';
import {
	importTemplate,
	parseSource,
	parseTemplateRef,
	type ConflictHandler,
	type Fetcher,
	type TemplateSource,
} from '../template-importer.js';

function toKebabCase(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export interface NewOptions {
	cwd?: string;
	fromTemplate?: string;
	source?: string | TemplateSource;
	format?: string;
	orientation?: string;
	fetcher?: Fetcher;
	homeDir?: string;
	noCache?: boolean;
	onConflict?: ConflictHandler;
}

export async function executeNew(name: string, options: NewOptions = {}): Promise<string> {
	const cwd = options.cwd ?? process.cwd();
	const destName = toKebabCase(name);

	if (!options.fromTemplate) {
		throw new Error(
			'Missing --from-template <coll>/<tpl>. Pick a source template (e.g. `--from-template structures/blank` for an empty page).'
		);
	}
	const templateRef = parseTemplateRef(options.fromTemplate);

	try {
		await readManifest(cwd);
	} catch {
		throw new Error(
			`No ${MANIFEST_FILENAME} found in ${cwd}. Run "poli init" first.`
		);
	}

	const source =
		typeof options.source === 'string' ? parseSource(options.source) : options.source;

	await importTemplate({
		source,
		templateRef,
		destTemplateName: destName,
		projectDir: cwd,
		fetcher: options.fetcher,
		homeDir: options.homeDir,
		noCache: options.noCache,
		onConflict: options.onConflict,
	});

	if (options.format || options.orientation) {
		const manifest = await readManifest(cwd);
		const entry = manifest.templates?.find((t) => t.name === destName);
		if (entry) {
			if (options.format) entry.format = options.format;
			if (options.orientation) entry.orientation = options.orientation;
			await writeManifest(cwd, manifest);
		}
	}

	const { join } = await import('node:path');
	return join(cwd, 'templates', destName);
}

export function registerNewCommand(program: Command) {
	program
		.command('new')
		.description('Create a new template from a source template')
		.argument('<name>', 'Destination template name (kebab-case in the project)')
		.requiredOption(
			'--from-template <ref>',
			'Source template, format <collection>/<template> (e.g. structures/blank)'
		)
		.option('--source <repo>', 'Source repo, format github:<owner>/<repo>')
		.option('--format <format>', 'Override the template format (e.g. A5)')
		.option(
			'--orientation <orientation>',
			'Override the template orientation (portrait | landscape)'
		)
		.option('--no-cache', 'Bypass the 24h source cache')
		.action(async (name: string, opts) => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');

			const spinner = ora('Importing template...').start();
			try {
				const templateDir = await executeNew(name, {
					fromTemplate: opts.fromTemplate,
					source: opts.source,
					format: opts.format,
					orientation: opts.orientation,
					noCache: opts.cache === false,
				});
				spinner.succeed(chalk.green(`Template imported at ${templateDir}`));
				console.log();
				console.log(`  ${chalk.bold('Next steps:')}`);
				console.log(`  ${chalk.cyan(`Edit templates/${toKebabCase(name)}/`)}`);
				console.log(`  ${chalk.cyan(`poli render ${toKebabCase(name)}`)}  — generate PDF`);
				console.log();
			} catch (error) {
				spinner.fail(
					chalk.red(error instanceof Error ? error.message : 'Failed to import template')
				);
				process.exitCode = 1;
			}
		});
}
