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
	type TemplateSource,
} from '../template-importer.js';

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
}

export async function executeInit(name: string, options: InitOptions = {}): Promise<string> {
	const cwd = options.cwd ?? process.cwd();
	const initInPlace = name === '.';
	const projectName = initInPlace ? basename(cwd) : toKebabCase(name);
	const projectDir = initInPlace ? cwd : join(cwd, projectName);

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

	if (options.withTemplate) {
		const templateRef = parseTemplateRef(options.withTemplate);
		const source =
			typeof options.source === 'string'
				? parseSource(options.source)
				: options.source;
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
			const { default: ora } = await import('ora');

			const spinner = ora('Creating project...').start();
			try {
				const projectDir = await executeInit(name, {
					withTemplate: opts.withTemplate,
					templateName: opts.templateName,
					source: opts.source,
					noCache: opts.cache === false,
				});
				spinner.succeed(chalk.green(`Project created at ${projectDir}`));
				console.log();
				console.log(`  ${chalk.bold('Next steps:')}`);
				console.log(`  ${chalk.cyan(`cd ${name === '.' ? '.' : toKebabCase(name)}`)}`);
				if (!opts.withTemplate) {
					console.log(
						`  ${chalk.cyan('poli new <name> --from-template structures/blank')}  — create your first template`
					);
				} else {
					console.log(`  ${chalk.cyan('poli render <template>')}  — generate PDF`);
				}
				console.log();
			} catch (error) {
				spinner.fail(
					chalk.red(error instanceof Error ? error.message : 'Failed to create project')
				);
				process.exitCode = 1;
			}
		});
}
