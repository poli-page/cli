import { Command } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
	loadProject,
	findTemplate,
	loadTemplate,
	unwrapMockJson,
} from '../project-loader.js';
import { createApiClient, type ApiClient } from '../api-client.js';
import { resolveAuth } from '../auth.js';
import { errorToExitCode } from '../exit-codes.js';

export interface RenderOptions {
	cwd?: string;
	output?: string;
	data?: string;
	version?: string;
	apiClient?: ApiClient;
	homeDir?: string;
}

export interface RenderResult {
	outputPath: string;
	version: string;
	environment: 'sandbox' | 'live' | null;
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;
const PARTIAL_SEMVER = /^\d+(?:\.\d+)?$/;

export async function executeRender(
	templateName: string,
	options: RenderOptions = {}
): Promise<RenderResult> {
	const cwd = options.cwd ?? process.cwd();
	const version = options.version ?? 'draft';

	validateVersion(version);

	const { manifest, projectDir } = await loadProject(cwd);
	const entry = findTemplate(manifest, templateName);
	const loaded = await loadTemplate(projectDir, entry);

	let data = loaded.data;
	let locale = loaded.locale;
	if (options.data) {
		const dataPath = resolve(cwd, options.data);
		const raw = JSON.parse(await readFile(dataPath, 'utf-8'));
		// Same dewrap as loadTemplate: accept both `{ locale, data: {...} }`
		// (the convention used by mock files and `poli init` scaffolds) and
		// flat shapes. Without this, passing the wrapped shape via --data
		// would result in `{ data: { data: {...} } }` reaching the engine.
		// --data fully replaces both data and locale — if the user wants the
		// mock locale, they keep it in their override file.
		const unwrapped = unwrapMockJson(raw);
		data = unwrapped.data;
		locale = unwrapped.locale;
	}

	const auth = await resolveAuth({
		manifestOrgId: manifest.cloud?.orgId,
		homeDir: options.homeDir,
	});

	const client = options.apiClient ?? createApiClient();
	const result = await client.renderPdf(auth.authorization, auth.orgIdHeader, {
		template: loaded.html,
		data,
		version,
		format: entry.format,
		orientation: entry.orientation,
		// Locale is optional — only forward it when actually set (in the mock
		// or in --data). Sending `locale: undefined` would still serialise as
		// `"locale":null` on some JSON paths and confuse the engine.
		...(locale ? { locale } : {}),
	});

	const outputDir = join(projectDir, 'output');
	await mkdir(outputDir, { recursive: true });
	const outputPath = options.output
		? resolve(cwd, options.output)
		: join(outputDir, `${templateName}.pdf`);
	await writeFile(outputPath, result.pdf);

	return { outputPath, version, environment: result.environment };
}

function validateVersion(version: string): void {
	if (version === 'draft') return;
	if (version === 'latest') {
		throw new Error(
			'`latest` was retired. Run `poli versions list` and pin an exact semver like `1.2.3`.'
		);
	}
	if (PARTIAL_SEMVER.test(version)) {
		throw new Error(
			'Use an exact semver `X.Y.Z`. Partial versions like `1.0` were retired.'
		);
	}
	if (!EXACT_SEMVER.test(version)) {
		throw new Error(
			'Invalid version: must be `draft` or an exact semver `X.Y.Z`.'
		);
	}
}

export function registerRenderCommand(program: Command) {
	program
		.command('render')
		.description('Render a PDF from a template')
		.argument('<name>', 'Template name')
		.option('-o, --output <path>', 'Output file path')
		.option('-d, --data <path>', 'JSON data file (overrides mock data)')
		.option(
			'--version <version>',
			'Version to render: `draft` or exact semver `X.Y.Z`',
			'draft'
		)
		.action(async (name: string, opts) => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');

			const spinner = ora(`Rendering ${name}...`).start();
			try {
				const result = await executeRender(name, {
					output: opts.output,
					data: opts.data,
					version: opts.version,
				});
				const envSuffix = result.environment
					? ` (${result.environment}${result.environment === 'live' ? ', billed' : ''})`
					: '';
				spinner.succeed(
					chalk.green(
						`Rendered ${name} v${result.version}${envSuffix} → ${result.outputPath}`
					)
				);
			} catch (error) {
				spinner.fail(
					chalk.red(error instanceof Error ? error.message : 'Rendering failed')
				);
				process.exitCode = errorToExitCode(error);
			}
		});
}
