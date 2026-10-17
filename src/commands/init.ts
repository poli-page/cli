import { Command } from 'commander';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { writeManifest } from '../manifest.js';
import { parseManifest, type PoliPageManifest } from '../manifest.schema.js';
import { readCredentials } from '../credentials.js';
import { createApiClient, type ApiClient } from '../api-client.js';
import { MANIFEST_FILENAME } from '../constants.js';
import { findOrganization, promptForOrganization, type Organization } from './link.js';
import {
	fetchStarter,
	importTemplate,
	parseSource,
	parseTemplateRef,
	type ConflictHandler,
	type Fetcher,
	type TemplateSource,
} from '../template-importer.js';
import { promptForStarterTemplate, type TemplatePromptResult } from '../template-prompt.js';
import { errorToExitCode, ExitCode } from '../exit-codes.js';
import { shouldEmitJson } from '../output.js';

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
		typeof options.source === 'string' ? parseSource(options.source) : options.source;

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

export interface InitStarterOptions {
	cwd?: string;
	source?: string | TemplateSource;
	fetcher?: Fetcher;
	homeDir?: string;
	noCache?: boolean;
	/** Write into a non-empty target directory. */
	force?: boolean;
	apiClient?: ApiClient;
	/** Organization to link to; needed only when the user has several. */
	org?: string;
	/** Asks which organization to link to when there are several and no `org`. */
	selectOrg?: (orgs: Organization[]) => Promise<string>;
}

export type StarterLink =
	| { status: 'linked'; orgSlug: string }
	| { status: 'unlinked'; reason: 'not-logged-in' | 'no-org' | 'several-orgs' }
	| { status: 'unlinked'; reason: 'no-project'; orgSlug: string };

export interface InitStarterResult {
	projectDir: string;
	link: StarterLink;
}

/**
 * `poli init --starter <name> [dir]`: write a starter project of the
 * templates repo (e.g. `getting-started/`) into `dir`, then link it to the
 * org's existing cloud project of the same slug. It never creates a cloud
 * project and never downloads from the cloud: the files come from the
 * public templates repo, the same source the API seeds from.
 */
export async function executeInitStarter(
	starter: string,
	dir: string | undefined,
	options: InitStarterOptions = {}
): Promise<InitStarterResult> {
	const cwd = options.cwd ?? process.cwd();
	const projectDir = resolve(cwd, dir ?? starter);
	const source =
		typeof options.source === 'string' ? parseSource(options.source) : options.source;

	const existing = await readdir(projectDir).catch(() => null);
	if (existing && existing.length > 0 && !options.force) {
		throw new Error(
			`Directory "${dir ?? starter}" is not empty. Pick another directory or pass --force.`
		);
	}

	// Fetch and link before touching the disk, so a network failure leaves
	// nothing half-written.
	const files = await fetchStarter(starter, source, {
		fetcher: options.fetcher,
		homeDir: options.homeDir,
		noCache: options.noCache,
	});
	const manifestFile = files.find((f) => f.path === MANIFEST_FILENAME)!;
	const manifest = parseManifest(JSON.parse(manifestFile.content.toString('utf-8')));
	// F3: a starter carries no version, and no cloud block but the one
	// the link step writes.
	delete manifest.project.version;
	delete manifest.cloud;

	const { link, cloud } = await linkStarter(starter, options);
	if (cloud) manifest.cloud = cloud;

	await mkdir(projectDir, { recursive: true });
	for (const file of files) {
		if (file.path === MANIFEST_FILENAME) continue;
		const dest = join(projectDir, ...file.path.split('/'));
		await mkdir(dirname(dest), { recursive: true });
		await writeFile(dest, file.content);
	}
	await writeManifest(projectDir, manifest);

	return { projectDir, link };
}

async function linkStarter(
	projectSlug: string,
	options: InitStarterOptions
): Promise<{ link: StarterLink; cloud?: PoliPageManifest['cloud'] }> {
	const credentials = await readCredentials(options.homeDir);
	if (!credentials?.session) {
		return { link: { status: 'unlinked', reason: 'not-logged-in' } };
	}

	const client = options.apiClient ?? createApiClient();
	const orgs = await client.getOrganizations(credentials.session);

	let orgSlug = options.org;
	if (!orgSlug) {
		if (orgs.length === 0) return { link: { status: 'unlinked', reason: 'no-org' } };
		if (orgs.length === 1) orgSlug = orgs[0].slug;
		else if (options.selectOrg) orgSlug = await options.selectOrg(orgs);
		else return { link: { status: 'unlinked', reason: 'several-orgs' } };
	}
	const org = findOrganization(orgs, orgSlug);

	const projects = await client.listProjects(credentials.session, org.id);
	const project = projects.find((p) => p.slug === projectSlug);
	if (!project) {
		return { link: { status: 'unlinked', reason: 'no-project', orgSlug: org.slug } };
	}

	return {
		link: { status: 'linked', orgSlug: org.slug },
		cloud: { orgSlug: org.slug, orgId: org.id, projectSlug, projectId: project.id },
	};
}

export function describeUnlinked(
	link: Extract<StarterLink, { status: 'unlinked' }>,
	starter: string
) {
	switch (link.reason) {
		case 'not-logged-in':
			return 'Not linked: you are not logged in. Run `poli login`, then `poli link` in the project.';
		case 'no-org':
			return 'Not linked: your account has no organization yet. Create one in the dashboard, then run `poli link`.';
		case 'several-orgs':
			return 'Not linked: you belong to several organizations. Re-run with `--org <slug>`, or run `poli link` in the project.';
		case 'no-project':
			return `Not linked: organization "${link.orgSlug}" has no "${starter}" project. Run \`poli link\` in the project to link it.`;
	}
}

interface InitCommandOptions {
	starter: string;
	org?: string;
	force?: boolean;
	withTemplate?: string;
	templateName?: string;
	source?: string;
	cache?: boolean;
	json?: boolean;
}

async function runInitStarter(name: string | undefined, opts: InitCommandOptions) {
	const { default: chalk } = await import('chalk');

	if (opts.withTemplate || opts.templateName) {
		console.error(
			chalk.red('--starter cannot be combined with --with-template or --template-name.')
		);
		process.exitCode = ExitCode.INVALID_USAGE;
		return;
	}
	const emitJson = shouldEmitJson(opts);
	try {
		const result = await executeInitStarter(opts.starter, name, {
			source: opts.source,
			noCache: opts.cache === false,
			force: opts.force,
			org: opts.org,
			// No prompt in JSON mode: it would mix with the JSON on stdout.
			selectOrg:
				process.stdin.isTTY && !emitJson
					? (orgs) => promptForOrganization(orgs, 'Select the organization to link to:')
					: undefined,
		});
		if (emitJson) {
			console.log(JSON.stringify({ starter: opts.starter, ...result }, null, 2));
			return;
		}
		console.log(chalk.green(`✓ Starter "${opts.starter}" written to ${result.projectDir}`));
		if (result.link.status === 'linked') {
			console.log(
				chalk.green(`✓ Linked to the "${opts.starter}" project of ${result.link.orgSlug}`)
			);
		} else {
			console.log(chalk.yellow(`⚠ ${describeUnlinked(result.link, opts.starter)}`));
		}
		console.log();
		console.log(`  ${chalk.bold('Next steps:')}`);
		console.log(`  ${chalk.cyan(`cd ${name ?? opts.starter}`)}`);
		console.log(
			`  ${chalk.cyan('poli watch')}                  — live sync of your edits to the cloud draft`
		);
		console.log(
			`  ${chalk.cyan('poli publish --env sandbox')}  — publish to the sandbox environment`
		);
		console.log('  Then re-run the dashboard snippet to see your change.');
		console.log();
	} catch (error) {
		console.error(
			chalk.red(error instanceof Error ? error.message : 'Failed to write the starter')
		);
		process.exitCode = errorToExitCode(error);
	}
}

export function registerInitCommand(program: Command) {
	program
		.command('init')
		.description('Scaffold a new Poli Page project, or write a starter project (--starter)')
		.argument(
			'[name]',
			'Project name (or "." for current directory); with --starter, the target directory (default: the starter name)'
		)
		.option(
			'--starter <name>',
			"Write a whole starter project (e.g. getting-started) and link it to the org's existing cloud project of the same name"
		)
		.option(
			'--org <slug>',
			'With --starter: organization to link to, when you belong to several'
		)
		.option('--force', 'With --starter: write into a non-empty directory')
		.option('--json', 'With --starter: print the result as JSON, even in a TTY')
		.option(
			'--with-template <ref>',
			'Pre-install a starter template, format <collection>/<template> (e.g. showcase/invoice)'
		)
		.option(
			'--template-name <name>',
			'Destination name for the imported template (default: source template name)'
		)
		.option('--source <repo>', 'Source repo, format github:<owner>/<repo>')
		.option('--no-cache', 'Bypass the 24h source cache')
		.action(async (name: string | undefined, opts) => {
			const { default: chalk } = await import('chalk');

			if (opts.starter) {
				await runInitStarter(name, opts);
				return;
			}

			if (!name) {
				console.error(
					chalk.red(
						'Missing project name: poli init <name>, or poli init --starter <name>.'
					)
				);
				process.exitCode = ExitCode.INVALID_USAGE;
				return;
			}

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
