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
	type RenderResult as ApiRenderResult,
} from '../api-client.js';
import { resolveAuth } from '../auth.js';
import { errorToExitCode } from '../exit-codes.js';
import { shouldEmitJson } from '../output.js';

export interface RenderOptions {
	cwd?: string;
	output?: string;
	data?: string;
	version?: string;
	noDownload?: boolean;
	apiClient?: ApiClient;
	homeDir?: string;
	/** Injectable for testing — defaults to global `fetch` on the presigned URL. */
	fetchPdf?: (url: string) => Promise<Buffer>;
}

export interface RenderResult {
	descriptor: ApiRenderResult;
	outputPath?: string;
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;
const PARTIAL_SEMVER = /^\d+(?:\.\d+)?$/;

/**
 * Parses a template spec of the form `name`, `name@draft`, or `name@X.Y.Z`.
 *
 * Purely structural — semver validity is checked downstream by
 * `executeRender` so the same friendly error path applies whether the
 * user wrote `--version` (legacy) or `name@version`.
 */
export function parseTemplateSpec(spec: string): { name: string; version: string } {
	if (spec === '') {
		throw new Error('Template name is required.');
	}
	const atIdx = spec.indexOf('@');
	if (atIdx === -1) {
		return { name: spec, version: 'draft' };
	}
	const name = spec.slice(0, atIdx);
	const rest = spec.slice(atIdx + 1);
	if (name === '') {
		throw new Error('Template name is required (got empty name in `@version` spec).');
	}
	if (rest === '') {
		throw new Error(
			'Version is required after `@` (e.g. `invoice@1.2.3` or `invoice@draft`).'
		);
	}
	if (rest.includes('@')) {
		throw new Error('Invalid template spec: only one `@` is allowed.');
	}
	return { name, version: rest };
}

export async function executeRender(
	templateName: string,
	options: RenderOptions = {}
): Promise<RenderResult> {
	const cwd = options.cwd ?? process.cwd();
	const version = options.version ?? 'draft';

	validateVersion(version);

	// `-o` and `--no-download` are mutually exclusive: -o means "write the PDF
	// to that path", --no-download means "don't fetch the PDF at all".
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
		// Same dewrap as loadTemplate. --data fully replaces both data and
		// locale; flat shapes pass through as-is.
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
	const descriptor = await client.render(auth.authorization, auth.orgIdHeader, {
		project: manifest.cloud.projectSlug,
		template: entry.name,
		version,
		data,
		format: entry.format,
		orientation: entry.orientation,
		...(locale ? { locale } : {}),
	});

	if (options.noDownload) {
		return { descriptor };
	}

	// Default download target: output/<templateSlug>/<templateSlug>.pdf
	// (one folder per template — keeps multiple renders organised).
	const outputPath = options.output
		? resolve(cwd, options.output)
		: join(projectDir, 'output', entry.name, `${entry.name}.pdf`);

	const pdfBuffer = options.fetchPdf
		? await options.fetchPdf(descriptor.presignedPdfUrl)
		: await defaultFetchPdf(descriptor.presignedPdfUrl);

	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, pdfBuffer);

	return { descriptor, outputPath };
}

/**
 * Build the JSON payload printed by `poli render --json`.
 *
 * Spreads the API descriptor and conditionally adds `outputPath` so callers
 * can locate the written PDF. `outputPath` is absent when `--no-download`
 * was passed (no file written).
 */
export function formatRenderJson(result: RenderResult): unknown {
	if (result.outputPath) {
		return { ...result.descriptor, outputPath: result.outputPath };
	}
	return result.descriptor;
}

async function defaultFetchPdf(url: string): Promise<Buffer> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`Failed to download PDF from presigned URL (HTTP ${response.status}).`
		);
	}
	const arrayBuffer = await response.arrayBuffer();
	return Buffer.from(arrayBuffer);
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
		.argument(
			'<spec>',
			'Template spec: `name` (draft) or `name@X.Y.Z` (explicit version)'
		)
		.option('-o, --output <path>', 'Output file path')
		.option('-d, --data <path>', 'JSON data file (overrides mock data)')
		.option(
			'--no-download',
			'Skip fetching the presigned PDF URL — only emit the JSON descriptor'
		)
		.option('--json', 'Force JSON output even in a TTY')
		.action(async (spec: string, opts) => {
			const { default: chalk } = await import('chalk');

			try {
				const { name, version } = parseTemplateSpec(spec);
				const result = await executeRender(name, {
					output: opts.output,
					data: opts.data,
					version,
					noDownload: opts.download === false,
				});

				// Pipe / --json / non-TTY → JSON. TTY → human summary.
				// Never both — picking one keeps stdout clean for either consumer.
				if (shouldEmitJson(opts)) {
					console.log(JSON.stringify(formatRenderJson(result), null, 2));
					return;
				}

				const env = result.descriptor.environment;
				const versionLabel = result.descriptor.version
					? `v${result.descriptor.version}`
					: 'vdraft';
				const envSuffix = ` (${env}${env === 'live' ? ', billed' : ''})`;
				if (result.outputPath) {
					console.log(
						chalk.green(
							`✓ Rendered ${name} ${versionLabel}${envSuffix} → ${result.outputPath}`
						)
					);
				} else {
					console.log(
						chalk.green(
							`✓ Document ${chalk.bold(result.descriptor.documentId)} ${versionLabel}${envSuffix} (no download)`
						)
					);
					console.log(
						`  ${chalk.dim('PDF URL:')} ${chalk.cyan(result.descriptor.presignedPdfUrl)}`
					);
				}
			} catch (error) {
				console.error(
					chalk.red(error instanceof Error ? error.message : 'Rendering failed')
				);
				process.exitCode = errorToExitCode(error);
			}
		});
}
