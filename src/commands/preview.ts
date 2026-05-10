import { Command } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
	loadProject,
	findTemplate,
	loadTemplate,
	unwrapMockJson,
} from '../project-loader.js';
import {
	createApiClient,
	type ApiClient,
	type PreviewApiResult,
} from '../api-client.js';
import { resolveAuth } from '../auth.js';
import { errorToExitCode } from '../exit-codes.js';
import { shouldEmitJson } from '../output.js';
import { parseTemplateSpec } from './render.js';

export interface PreviewOptions {
	cwd?: string;
	output?: string;
	data?: string;
	version?: string;
	noDownload?: boolean;
	apiClient?: ApiClient;
	homeDir?: string;
}

export interface PreviewDescriptor {
	templateSlug: string;
	projectSlug: string;
	version: string;
	environment: 'sandbox' | 'live';
	format: string;
	orientation: 'portrait' | 'landscape';
	locale: string | null;
	pageCount: number;
	outputPath?: string;
	html?: string;
}

export interface PreviewResult {
	descriptor: PreviewDescriptor;
	outputPath?: string;
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;
const PARTIAL_SEMVER = /^\d+(?:\.\d+)?$/;

export async function executePreview(
	templateName: string,
	options: PreviewOptions = {}
): Promise<PreviewResult> {
	const cwd = options.cwd ?? process.cwd();
	const version = options.version ?? 'draft';

	validateVersion(version);

	if (options.noDownload && options.output) {
		throw new Error('Use either `-o, --output` or `--no-download`, not both.');
	}

	const { manifest, projectDir } = await loadProject(cwd);
	const entry = findTemplate(manifest, templateName);
	const loaded = await loadTemplate(projectDir, entry);

	let data = loaded.data;
	let locale = loaded.locale;
	if (options.data) {
		const dataPath = resolve(cwd, options.data);
		const raw = JSON.parse(await readFile(dataPath, 'utf-8'));
		const unwrapped = unwrapMockJson(raw);
		data = unwrapped.data;
		locale = unwrapped.locale;
	}

	if (!manifest.cloud?.projectSlug) {
		throw new Error(
			"This folder isn't linked to a cloud project. Run `poli link` first."
		);
	}

	const auth = await resolveAuth({
		manifestOrgId: manifest.cloud.orgId,
		homeDir: options.homeDir,
	});

	const client = options.apiClient ?? createApiClient();
	const apiResult: PreviewApiResult = await client.renderPreview(
		auth.authorization,
		auth.orgIdHeader,
		{
			project: manifest.cloud.projectSlug,
			template: entry.name,
			version,
			data,
			format: entry.format,
			orientation: entry.orientation,
			...(locale ? { locale } : {}),
		}
	);

	const baseDescriptor: PreviewDescriptor = {
		templateSlug: entry.name,
		projectSlug: manifest.cloud.projectSlug,
		version,
		environment: apiResult.environment,
		format: entry.format,
		orientation: entry.orientation as 'portrait' | 'landscape',
		locale: locale ?? null,
		pageCount: apiResult.totalPages,
	};

	if (options.noDownload) {
		return {
			descriptor: { ...baseDescriptor, html: apiResult.html },
		};
	}

	const formatOrientationSlug = `${entry.format.toLowerCase()}-${entry.orientation}`;
	const outputPath = options.output
		? resolve(cwd, options.output)
		: join(projectDir, 'output', entry.name, formatOrientationSlug, 'output.html');

	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, apiResult.html, 'utf-8');

	return {
		descriptor: { ...baseDescriptor, outputPath },
		outputPath,
	};
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

export function registerPreviewCommand(program: Command) {
	program
		.command('preview')
		.description('Render a template to a local HTML preview file')
		.argument(
			'<spec>',
			'Template spec: `name` (draft) or `name@X.Y.Z` (explicit version)'
		)
		.option('-o, --output <path>', 'Output HTML file path')
		.option('-d, --data <path>', 'JSON data file (overrides mock data)')
		.option(
			'--no-download',
			'Skip writing the HTML file — only emit the JSON descriptor (use with --json or pipe)'
		)
		.option('--json', 'Force JSON output even in a TTY')
		.action(async (spec: string, opts) => {
			const { default: chalk } = await import('chalk');

			try {
				const { name, version } = parseTemplateSpec(spec);
				const result = await executePreview(name, {
					output: opts.output,
					data: opts.data,
					version,
					noDownload: opts.download === false,
				});

				if (shouldEmitJson(opts)) {
					console.log(JSON.stringify(result.descriptor, null, 2));
					return;
				}

				const versionLabel = `v${result.descriptor.version}`;
				const env = result.descriptor.environment;
				const envSuffix = ` (${env}${env === 'live' ? ', billed' : ''})`;
				const formatLabel = `${result.descriptor.format} ${result.descriptor.orientation}`;
				const pagesLabel = `${result.descriptor.pageCount} page${result.descriptor.pageCount === 1 ? '' : 's'}`;

				if (result.outputPath) {
					console.log(
						chalk.green(
							`✓ Previewed ${name} ${versionLabel}${envSuffix} — ${formatLabel}, ${pagesLabel}`
						)
					);
					console.log(
						`  Navigate to ${chalk.cyan(`file://${result.outputPath}`)} to display this preview in the browser`
					);
				} else {
					console.log(
						chalk.green(
							`✓ Previewed ${name} ${versionLabel}${envSuffix} — ${formatLabel}, ${pagesLabel} (no file written)`
						)
					);
					console.log(
						chalk.dim('  Use --json or pipe the command to capture the HTML.')
					);
				}
			} catch (error) {
				console.error(
					chalk.red(error instanceof Error ? error.message : 'Preview failed')
				);
				process.exitCode = errorToExitCode(error);
			}
		});
}
