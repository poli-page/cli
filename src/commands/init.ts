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
import {
	promptForStarterTemplate,
	type TemplatePromptResult,
} from '../template-prompt.js';
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

// Templates use Poli Page's authoring syntax (`{{ interp }}`, `@for`, `@if`,
// `@let`) which Prettier's HTML parser doesn't understand — it either
// reformats the markup into invalid output or marks the whole file as
// erroring in the editor. Ignoring the template HTML (and partials) keeps
// the editor noise away while still letting Prettier handle everything else
// (JSON mocks, tailwind.css, the manifest).
const PRETTIERIGNORE_TEMPLATE = `# Poli Page template syntax (interpolation, @for/@if/@let) isn't HTML —
# Prettier mangles it. Skip the template markup and any generated output.
templates/**/*.html
partials/**/*.html
output/
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
	 * template + destination name). Override this for tests, or pass
	 * `null`-returning to disable.
	 */
	promptForTemplate?: () => Promise<TemplatePromptResult | null>;
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

	// Resolve the template ref (and optionally a custom destName from the
	// prompt) BEFORE scaffolding, so a network failure during the prompt
	// doesn't leave a half-created project on disk.
	let promptResult: TemplatePromptResult | null = options.withTemplate
		? { ref: parseTemplateRef(options.withTemplate) }
		: null;

	if (!promptResult) {
		const prompt =
			options.promptForTemplate ??
			(() =>
				promptForStarterTemplate({
					source,
					fetcher: options.fetcher,
					homeDir: options.homeDir,
					noCache: options.noCache,
					// Init asks for the destination name after picking a template
					// (default = source template name). `new` already takes it as
					// a positional arg, so it does NOT pass this flag.
					promptDestName: true,
				}));
		promptResult = await prompt();
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
			// `0.0.0` lets bump-driven first push pick the version family:
			// `poli push --patch` → `0.0.1`, `--minor` → `0.1.0`,
			// `--major` → `1.0.0`. Anything other than an exact semver
			// would fall back to 0.0.0 anyway in the API (api 0.7.1+).
			version: '0.0.0',
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
	await writeFile(join(projectDir, '.prettierignore'), PRETTIERIGNORE_TEMPLATE, 'utf-8');

	if (promptResult) {
		// Precedence for the destination template name:
		//   1. explicit --template-name flag (options.templateName)
		//   2. value returned by the interactive prompt (promptResult.destName)
		//   3. the source template's own name (default in importTemplate)
		const destTemplateName = options.templateName
			? toKebabCase(options.templateName)
			: promptResult.destName
				? toKebabCase(promptResult.destName)
				: undefined;

		await importTemplate({
			source,
			templateRef: promptResult.ref,
			destTemplateName,
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
