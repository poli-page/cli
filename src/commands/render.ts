import { Command } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadProject, findTemplate, loadTemplate, unwrapMockJson } from '../project-loader.js';
import {
	ApiError,
	createApiClient,
	type ApiClient,
	type RenderResult as ApiRenderResult,
} from '../api-client.js';
import { resolveAuth } from '../auth.js';
import { isValidEnvironmentName } from '../environment-name.js';
import { UsageError, errorToExitCode } from '../exit-codes.js';
import { shouldEmitJson } from '../output.js';
import { formatOrientationSlug } from '../format-resolver.js';

export interface RenderOptions {
	cwd?: string;
	output?: string;
	data?: string;
	/** `draft` (the default) or the name of an environment the project is published in. */
	target?: string;
	noDownload?: boolean;
	apiClient?: ApiClient;
	homeDir?: string;
	/** Injectable for testing — defaults to global `fetch` on the presigned URL. */
	fetchPdf?: (url: string) => Promise<Buffer>;
	/** Injectable for testing — the wait before the `PUBLISH_IN_PROGRESS` retry. */
	sleep?: (ms: number) => Promise<void>;
}

/**
 * The draft renders to PDF bytes only: no stored document, no descriptor.
 * An environment render stores a document and returns its descriptor.
 */
export type RenderResult =
	| { kind: 'draft'; template: string; outputPath: string }
	| { kind: 'environment'; descriptor: ApiRenderResult; outputPath?: string };

const DRAFT = 'draft';

/**
 * Parses a template spec of the form `name`, `name@draft`, or `name@<environment>`.
 *
 * Purely structural — the target is checked by `executeRender`, so
 * programmatic callers get the same errors as the command line.
 */
export function parseTemplateSpec(spec: string): { name: string; target: string } {
	if (spec === '') {
		throw new UsageError('Template name is required.');
	}
	const atIdx = spec.indexOf('@');
	if (atIdx === -1) {
		return { name: spec, target: DRAFT };
	}
	const name = spec.slice(0, atIdx);
	const rest = spec.slice(atIdx + 1);
	if (name === '') {
		throw new UsageError('Template name is required (got empty name in `@environment` spec).');
	}
	if (rest === '') {
		throw new UsageError(
			'Environment is required after `@` (e.g. `invoice@sandbox` or `invoice@draft`).'
		);
	}
	if (rest.includes('@')) {
		throw new UsageError('Invalid template spec: only one `@` is allowed.');
	}
	return { name, target: rest };
}

function validateTarget(name: string, target: string): void {
	if (target === DRAFT) return;
	if (target === 'latest' || /^\d/.test(target)) {
		throw new UsageError(
			`\`${name}@${target}\`: templates no longer have versions. Render a published environment with \`${name}@<environment>\` (e.g. \`${name}@sandbox\`), or the draft with \`${name}\`.`
		);
	}
	if (!isValidEnvironmentName(target)) {
		throw new UsageError(
			`Invalid environment name \`${target}\`: 1-20 lowercase letters, digits and single inner hyphens, starting with a letter. Use \`${name}@<environment>\`.`
		);
	}
}

export async function executeRender(
	templateName: string,
	options: RenderOptions = {}
): Promise<RenderResult> {
	const cwd = options.cwd ?? process.cwd();
	const target = options.target ?? DRAFT;

	validateTarget(templateName, target);

	// `-o` and `--no-download` are mutually exclusive: -o means "write the PDF
	// to that path", --no-download means "don't fetch the PDF at all".
	if (options.noDownload && options.output) {
		throw new Error('Use either `-o, --output` or `--no-download`, not both.');
	}
	if (options.noDownload && target === DRAFT) {
		throw new UsageError(
			`\`--no-download\` needs a stored document, and the draft is never stored. Drop \`--no-download\`, or render \`${templateName}@<environment>\`.`
		);
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
		throw new Error("This folder isn't linked to a cloud project. Run `poli link` first.");
	}
	const project = manifest.cloud.projectSlug;

	const auth = await resolveAuth({
		manifestOrgId: manifest.cloud.orgId,
		homeDir: options.homeDir,
	});

	// Default download target:
	//   output/<templateSlug>/<format-orientation>/<templateSlug>.pdf
	// The format/orientation segment lets the same template coexist on disk
	// at multiple page formats without overwriting itself, and aligns with
	// the layout produced by the desktop editor.
	const outputPath = options.output
		? resolve(cwd, options.output)
		: join(
				projectDir,
				'output',
				entry.name,
				formatOrientationSlug(entry.format, entry.orientation),
				`${entry.name}.pdf`
			);

	const client = options.apiClient ?? createApiClient();
	const payload = {
		project,
		template: entry.name,
		data,
		format: entry.format,
		orientation: entry.orientation,
		...(locale ? { locale } : {}),
	};

	// G1: only a session renders the draft. K1: a key renders only the
	// environment it is bound to. Both are refused before any API call.
	if (target === DRAFT) {
		if (auth.mode === 'api-key') {
			throw new UsageError(
				`API keys render a published environment: use \`${templateName}@<environment>\`. This key renders \`${auth.environment}\`: \`${templateName}@${auth.environment}\`.`
			);
		}
		const pdf = await client.renderDraft(auth.authorization, auth.orgIdHeader, payload);
		await writePdf(outputPath, pdf);
		return { kind: 'draft', template: entry.name, outputPath };
	}

	if (auth.mode === 'api-key' && target !== auth.environment) {
		throw new UsageError(
			`This API key renders the \`${auth.environment}\` environment, not \`${target}\`. Use \`${templateName}@${auth.environment}\`, or a key for \`${target}\`.`
		);
	}

	const descriptor = await renderEnvironment(
		() =>
			client.render(auth.authorization, auth.orgIdHeader, {
				...payload,
				environment: target,
			}),
		{ project, template: entry.name, environment: target },
		options.sleep ?? sleep
	);

	if (options.noDownload) {
		return { kind: 'environment', descriptor };
	}

	const pdfBuffer = options.fetchPdf
		? await options.fetchPdf(descriptor.presignedPdfUrl)
		: await defaultFetchPdf(descriptor.presignedPdfUrl);
	await writePdf(outputPath, pdfBuffer);

	return { kind: 'environment', descriptor, outputPath };
}

/**
 * Run an environment render, retrying once after `Retry-After` while a
 * publish of the same project and environment holds it, and turning the
 * environment errors into messages that say what to do.
 */
async function renderEnvironment(
	render: () => Promise<ApiRenderResult>,
	ctx: { project: string; template: string; environment: string },
	wait: (ms: number) => Promise<void>
): Promise<ApiRenderResult> {
	try {
		try {
			return await render();
		} catch (err) {
			if (!(err instanceof ApiError) || err.code !== 'PUBLISH_IN_PROGRESS') throw err;
			await wait((err.retryAfter ?? 1) * 1000);
			return await render();
		}
	} catch (err) {
		throw describeEnvironmentError(err, ctx);
	}
}

function describeEnvironmentError(
	err: unknown,
	{ project, template, environment }: { project: string; template: string; environment: string }
): unknown {
	if (!(err instanceof ApiError)) return err;
	switch (err.code) {
		case 'PROJECT_NOT_IN_ENVIRONMENT':
			return new UsageError(
				`Project \`${project}\` is not published in \`${environment}\`. Publish it with \`poli publish --env ${environment}\`.`
			);
		case 'ENVIRONMENT_NOT_FOUND':
			return new UsageError(`This organization has no environment \`${environment}\`.`);
		case 'TEMPLATE_NOT_FOUND':
			return new UsageError(
				`Template \`${template}\` is not in the copy of \`${project}\` published in \`${environment}\`. Publish it with \`poli publish --env ${environment}\`.`
			);
		case 'PUBLISH_IN_PROGRESS':
			return new ApiError(
				err.code,
				err.httpStatus,
				`A publish of \`${project}\` to \`${environment}\` is still running. Try again in a moment.`,
				err.retryAfter
			);
		default:
			return err;
	}
}

/**
 * The success-line label: `name@draft`, `name@<env>`, and `(billed)` for
 * every environment but `sandbox` (R1/R2). The draft is never counted.
 */
export function renderLabel(name: string, environment: string): string {
	const billed = environment !== DRAFT && environment !== 'sandbox';
	return `${name}@${environment}${billed ? ' (billed)' : ''}`;
}

/**
 * Build the JSON payload printed by `poli render --json`.
 *
 * An environment render prints the API descriptor, plus `outputPath` when a
 * PDF was written (absent with `--no-download`). The draft has no
 * descriptor: it prints `{ template, environment: "draft", outputPath }`.
 */
export function formatRenderJson(result: RenderResult): unknown {
	if (result.kind === 'draft') {
		return { template: result.template, environment: DRAFT, outputPath: result.outputPath };
	}
	if (result.outputPath) {
		return { ...result.descriptor, outputPath: result.outputPath };
	}
	return result.descriptor;
}

async function writePdf(outputPath: string, pdf: Buffer): Promise<void> {
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, pdf);
}

async function defaultFetchPdf(url: string): Promise<Buffer> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download PDF from presigned URL (HTTP ${response.status}).`);
	}
	const arrayBuffer = await response.arrayBuffer();
	return Buffer.from(arrayBuffer);
}

export function registerRenderCommand(program: Command) {
	program
		.command('render')
		.description('Render a PDF from a template')
		.argument(
			'<spec>',
			'Template spec: `name` (the draft, needs `poli login`) or `name@<environment>` (a published environment)'
		)
		.option('-o, --output <path>', 'Output file path')
		.option('-d, --data <path>', 'JSON data file (overrides mock data)')
		.option(
			'--no-download',
			'Skip fetching the presigned PDF URL — only emit the JSON descriptor (environment renders only)'
		)
		.option('--json', 'Force JSON output even in a TTY')
		.action(async (spec: string, opts) => {
			const { default: chalk } = await import('chalk');

			try {
				const { name, target } = parseTemplateSpec(spec);
				const result = await executeRender(name, {
					output: opts.output,
					data: opts.data,
					target,
					noDownload: opts.download === false,
				});

				// Pipe / --json / non-TTY → JSON. TTY → human summary.
				// Never both — picking one keeps stdout clean for either consumer.
				if (shouldEmitJson(opts)) {
					console.log(JSON.stringify(formatRenderJson(result), null, 2));
					return;
				}

				if (result.kind === 'draft') {
					console.log(
						chalk.green(`✓ Rendered ${renderLabel(name, DRAFT)} → ${result.outputPath}`)
					);
					return;
				}
				const label = renderLabel(name, result.descriptor.environment);
				if (result.outputPath) {
					console.log(chalk.green(`✓ Rendered ${label} → ${result.outputPath}`));
				} else {
					console.log(
						chalk.green(
							`✓ Document ${chalk.bold(result.descriptor.documentId)} ${label} (no download)`
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
