import { Command } from 'commander';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { writeManifest } from '../manifest.js';
import type { PoliPageManifest } from '../manifest.js';
import {
	importTemplate,
	parseSource,
	parseTemplateRef,
	type ConflictHandler,
	type Fetcher,
	type TemplateRef,
	type TemplateSource,
} from '../template-importer.js';
import { promptForStarterTemplate } from '../template-prompt.js';
import { errorToExitCode } from '../exit-codes.js';

function toKebabCase(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

const TAILWIND_CSS_TEMPLATE = `@import 'tailwindcss';

@theme {
\t--font-sans: 'Inter', sans-serif;
}
`;

const GITIGNORE_TEMPLATE = `node_modules
output/
dist/
.DS_Store
`;

export interface InitOptions {
	cwd?: string;
	withTemplate?: string;
	templateName?: string;
	source?: string | TemplateSource;
	fetcher?: Fetcher;
	homeDir?: string;
	noCache?: boolean;
	onConflict?: ConflictHandler;
	/**
	 * When `withTemplate` is not provided and the shell is interactive,
	 * the CLI prompts the user to pick a starter template (collection +
	 * template, with descriptions). Override this for tests, or pass
	 * `null`-returning to disable.
	 */
	promptForTemplate?: () => Promise<TemplateRef | null>;
}

export async function executeInit(name: string, options: InitOptions = {}): Promise<string> {
	const cwd = options.cwd ?? process.cwd();
	const initInPlace = name === '.';
	const projectName = initInPlace ? basename(cwd) : toKebabCase(name);
	const projectDir = initInPlace ? cwd : join(cwd, projectName);

	// Resolve the source once; we use it both for the prompt and for the
	// downstream import call.
	const source =
		typeof options.source === 'string'
			? parseSource(options.source)
			: options.source;

	// Resolve the template ref before scaffolding so a network failure in
	// the prompt doesn't leave a half-created project on disk.
	let templateRef: TemplateRef | null = options.withTemplate
		? parseTemplateRef(options.withTemplate)
		: null;

	if (!templateRef) {
		const prompt =
			options.promptForTemplate ??
			(() =>
				promptForStarterTemplate({
					source,
					fetcher: options.fetcher,
					homeDir: options.homeDir,
					noCache: options.noCache,
				}));
		templateRef = await prompt();
	}

	if (!initInPlace) {
		const exists = await stat(projectDir).catch(() => null);
		if (exists) {
			throw new Error(`Directory "${projectName}" already exists.`);
		}
		await mkdir(projectDir, { recursive: true });
	}

	const manifest: PoliPageManifest = {
		project: {
			name: projectName,
			version: '1.0',
		},
		fonts: [],
		templates: [],
	};

	await writeManifest(projectDir, manifest);
	await mkdir(join(projectDir, 'templates'), { recursive: true });
	await mkdir(join(projectDir, 'partials'), { recursive: true });
	await mkdir(join(projectDir, 'assets', 'fonts'), { recursive: true });
	await mkdir(join(projectDir, 'assets', 'images'), { recursive: true });
	await writeFile(join(projectDir, 'tailwind.css'), TAILWIND_CSS_TEMPLATE, 'utf-8');
	await writeFile(join(projectDir, '.gitignore'), GITIGNORE_TEMPLATE, 'utf-8');

	if (templateRef) {
		await importTemplate({
			source,
			templateRef,
			destTemplateName: options.templateName
				? toKebabCase(options.templateName)
				: undefined,
			projectDir,
			fetcher: options.fetcher,
			homeDir: options.homeDir,
			noCache: options.noCache,
			onConflict: options.onConflict,
		});
	}

	return projectDir;
}

export function registerInitCommand(program: Command) {
	program
		.command('init')
		.description('Scaffold a new Poli Page project')
		.argument('<name>', 'Project name (or "." for current directory)')
		.option(
			'--with-template <ref>',
			'Pre-install a starter template, format <collection>/<template> (e.g. showcase/invoice)'
		)
		.option('--template-name <name>', 'Destination name for the imported template (default: source template name)')
		.option('--source <repo>', 'Source repo, format github:<owner>/<repo>')
		.option('--no-cache', 'Bypass the 24h source cache')
		.action(async (name: string, opts) => {
			const { default: chalk } = await import('chalk');

			try {
				// No spinner here — `executeInit` may show an interactive prompt
				// (collection + template) and a spinner would clobber the choices.
				const projectDir = await executeInit(name, {
					withTemplate: opts.withTemplate,
					templateName: opts.templateName,
					source: opts.source,
					noCache: opts.cache === false,
				});
				console.log(chalk.green(`✓ Project created at ${projectDir}`));
				console.log();
				console.log(`  ${chalk.bold('Next steps:')}`);
				console.log(`  ${chalk.cyan(`cd ${name === '.' ? '.' : toKebabCase(name)}`)}`);
				if (!opts.withTemplate) {
					console.log(
						`  ${chalk.cyan('poli new <name>')}  — add another template (interactive picker)`
					);
				} else {
					console.log(`  ${chalk.cyan('poli render <template>')}  — generate PDF`);
				}
				console.log();
			} catch (error) {
				console.error(
					chalk.red(error instanceof Error ? error.message : 'Failed to create project')
				);
				process.exitCode = errorToExitCode(error);
			}
		});
}
