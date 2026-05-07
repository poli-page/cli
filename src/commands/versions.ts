import { Command } from 'commander';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import {
	type ApiClient,
	type VersionInfo,
	type VersionState,
} from '../api-client.js';
import { MANIFEST_FILENAME } from '../constants.js';
import { resolveCloudContext } from '../cloud-context.js';
import { registerVersionStateSubcommands } from './version-state.js';
import { errorToExitCode } from '../exit-codes.js';
import { shouldEmitJson } from '../output.js';

export { resolveCloudContext, validateExactSemver, EXACT_SEMVER, type CloudContext } from '../cloud-context.js';

type ChalkFn = (s: string) => string;
type ChalkLike = Record<'green' | 'cyan' | 'yellow' | 'red' | 'gray', ChalkFn>;

function formatStateBadge(state: VersionState, chalk: ChalkLike): string {
	const padded = state.padEnd(11);
	switch (state) {
		case 'LIVE':
			return chalk.green(padded);
		case 'SANDBOX':
			return chalk.cyan(padded);
		case 'DEPRECATED':
			return chalk.yellow(padded);
		case 'DELETED':
			return chalk.red(padded);
	}
}


// ─── versions list ──────────────────────────────────────────────────────────────

export interface VersionsListOptions {
	cwd?: string;
	apiClient?: ApiClient;
	homeDir?: string;
}

export async function executeVersionsList(options: VersionsListOptions): Promise<VersionInfo[]> {
	const { client, ctx } = await resolveCloudContext(options);
	return client.listVersions(ctx.session, ctx.orgId, ctx.projectId);
}

// ─── versions download ─────────────────────────────────────────────────────────

export interface VersionsDownloadOptions {
	version: string;
	outputDir: string;
	cwd?: string;
	apiClient?: ApiClient;
	homeDir?: string;
}

export async function executeVersionsDownload(options: VersionsDownloadOptions): Promise<void> {
	const { client, ctx } = await resolveCloudContext(options);
	const bundle = await client.downloadVersion(
		ctx.session,
		ctx.orgId,
		ctx.projectId,
		options.version,
	);

	const targetDir = options.outputDir;
	await mkdir(targetDir, { recursive: true });

	const manifest = bundle.manifest as Record<string, any>;

	// Write templates
	for (const tpl of manifest.templates ?? []) {
		const templateDir = join(targetDir, 'templates', tpl.name);
		await mkdir(templateDir, { recursive: true });

		const htmlFile = bundle.templates.find(
			(f) => f.path === tpl.template || f.path === `${tpl.name}.html`,
		);
		if (htmlFile) {
			await writeFile(join(templateDir, tpl.template), htmlFile.content, 'utf-8');
		}

		if (tpl.mock) {
			const mockFile = bundle.templates.find(
				(f) => f.path === tpl.mock || f.path === `${tpl.name}.json`,
			);
			if (mockFile) {
				await writeFile(join(templateDir, tpl.mock), mockFile.content, 'utf-8');
			}
		}
	}

	// Write assets
	if (bundle.images) {
		for (const img of bundle.images) {
			const assetPath = join(targetDir, 'assets', img.path);
			await mkdir(dirname(assetPath), { recursive: true });
			await writeFile(assetPath, Buffer.from(img.data, 'base64'));
		}
	}

	// Write tailwind.css
	if (bundle.tailwindCss) {
		await writeFile(join(targetDir, 'tailwind.css'), bundle.tailwindCss, 'utf-8');
	}

	// Write manifest with cloud metadata
	manifest.cloud = { orgSlug: ctx.orgSlug, projectId: ctx.projectId };
	await writeFile(
		join(targetDir, MANIFEST_FILENAME),
		JSON.stringify(manifest, null, '\t') + '\n',
		'utf-8',
	);
}

// ─── CLI registration ───────────────────────────────────────────────────────────

export function registerVersionsCommands(program: Command) {
	const versions = program.command('versions').description('Manage published versions');
	registerVersionStateSubcommands(versions);

	versions
		.command('list')
		.alias('ls')
		.description('List versions of the current project with state badges')
		.option('--json', 'Force JSON output even in a TTY')
		.action(async (opts: { json?: boolean }) => {
			const { default: chalk } = await import('chalk');

			try {
				const list = await executeVersionsList({});

				if (shouldEmitJson(opts)) {
					console.log(JSON.stringify(list, null, 2));
					return;
				}

				if (list.length === 0) {
					console.log(chalk.yellow('No versions yet. Run `poli push` first.'));
					return;
				}

				console.log(chalk.bold('Versions:\n'));
				console.log(
					`  ${chalk.dim('STATE'.padEnd(12))} ${chalk.dim('VERSION'.padEnd(10))} ${chalk.dim('PUSHED'.padEnd(13))} ${chalk.dim('MESSAGE')}`
				);
				for (const v of list) {
					const stateLabel = formatStateBadge(v.state, chalk);
					const date = new Date(v.createdAt).toLocaleDateString(undefined, {
						year: 'numeric',
						month: 'short',
						day: 'numeric',
					});
					const message = v.message ? chalk.dim(v.message) : '';
					console.log(
						`  ${stateLabel} ${chalk.bold(v.version.padEnd(10))} ${chalk.gray(date.padEnd(13))} ${message}`
					);
				}
			} catch (error) {
				console.error(chalk.red(error instanceof Error ? error.message : 'Failed'));
				process.exitCode = errorToExitCode(error);
			}
		});

	versions
		.command('download <version>')
		.description('Download a published version to a local directory')
		.option('-o, --output <dir>', 'Output directory', '.')
		.action(async (version: string, opts: { output: string }) => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');

			try {
				const spinner = ora(`Downloading version ${version}...`).start();
				await executeVersionsDownload({ version, outputDir: opts.output });
				spinner.succeed(chalk.green(`Version ${version} downloaded to ${opts.output}`));
			} catch (error) {
				console.error(chalk.red(error instanceof Error ? error.message : 'Download failed'));
				process.exitCode = errorToExitCode(error);
			}
		});
}
