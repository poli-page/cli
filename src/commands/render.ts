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
		.argument('<name>', 'Template name')
		.option('-o, --output <path>', 'Output file path')
		.option('-d, --data <path>', 'JSON data file (overrides mock data)')
		.option(
			'--version <version>',
			'Version to render: `draft` or exact semver `X.Y.Z`',
			'draft'
		)
		.option(
			'--no-download',
			'Skip fetching the presigned PDF URL — only print the JSON descriptor'
		)
		.action(async (name: string, opts) => {
			const { default: chalk } = await import('chalk');

			try {
				const result = await executeRender(name, {
					output: opts.output,
					data: opts.data,
					version: opts.version,
					noDownload: opts.download === false,
				});

				// Always print the JSON descriptor on stdout — pipelines (jq, CI)
				// rely on it. Pretty-printed for human readability; one render =
				// one JSON object so consumers can `tail -1` if they need to.
				console.log(JSON.stringify(result.descriptor, null, 2));

				if (result.outputPath) {
					const env = result.descriptor.environment;
					const versionLabel = result.descriptor.version
						? `v${result.descriptor.version}`
						: 'vdraft';
					const envSuffix = ` (${env}${env === 'live' ? ', billed' : ''})`;
					console.error(
						chalk.green(
							`✓ Rendered ${name} ${versionLabel}${envSuffix} → ${result.outputPath}`
						)
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
