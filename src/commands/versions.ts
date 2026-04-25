import { Command } from 'commander';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { readManifest } from '../manifest.js';
import { getSessionToken } from '../credentials.js';
import { createApiClient, type ApiClient, type VersionInfo } from '../api-client.js';
import { MANIFEST_FILENAME } from '../constants.js';

interface CloudContext {
	session: string;
	orgId: string;
	orgSlug: string;
	projectId: string;
}

async function resolveCloudContext(options: {
	cwd?: string;
	apiClient?: ApiClient;
	homeDir?: string;
}): Promise<{ client: ApiClient; ctx: CloudContext }> {
	const cwd = options.cwd ?? process.cwd();
	const client = options.apiClient ?? createApiClient();
	const session = await getSessionToken(options.homeDir);

	let manifest;
	try {
		manifest = await readManifest(cwd);
	} catch {
		throw new Error(`No ${MANIFEST_FILENAME} found in ${cwd}. Are you in a Poli Page project?`);
	}

	if (!manifest.cloud) {
		throw new Error('Project is not linked to any organization. Run "poli link" first.');
	}

	const { orgSlug, projectId } = manifest.cloud;
	const orgs = await client.getOrganizations(session);
	const org = orgs.find((o) => o.slug === orgSlug);
	if (!org) {
		throw new Error(`Organization "${orgSlug}" not found.`);
	}

	return { client, ctx: { session, orgId: org.id, orgSlug, projectId } };
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

	versions
		.command('list')
		.description('List published versions')
		.action(async () => {
			const { default: chalk } = await import('chalk');

			try {
				const list = await executeVersionsList({});

				if (list.length === 0) {
					console.log(chalk.yellow('No published versions yet. Run "poli publish" first.'));
					return;
				}

				console.log(chalk.bold('Published versions:\n'));
				for (const v of list) {
					const date = new Date(v.createdAt).toLocaleDateString(undefined, {
						year: 'numeric',
						month: 'short',
						day: 'numeric',
					});
					console.log(`  ${chalk.green(v.version.padEnd(12))} ${chalk.gray(date)}`);
				}
			} catch (error) {
				console.error(chalk.red(error instanceof Error ? error.message : 'Failed'));
				process.exitCode = 1;
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
				process.exitCode = 1;
			}
		});
}
