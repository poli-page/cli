import { Command } from 'commander';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readManifest, writeManifest } from '../manifest.js';
import { getSessionToken } from '../credentials.js';
import { createApiClient, type ApiClient } from '../api-client.js';
import { MANIFEST_FILENAME } from '../constants.js';

export interface CheckoutOptions {
	cwd?: string;
	version: string;
	apiClient?: ApiClient;
	homeDir?: string;
	yes?: boolean;
	confirmOverwrite?: () => Promise<boolean>;
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;
const PARTIAL_SEMVER = /^\d+(?:\.\d+)?$/;

function validateVersion(version: string): void {
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
		throw new Error('Invalid version: must be an exact semver `X.Y.Z`.');
	}
}

export async function executeCheckout(options: CheckoutOptions): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	validateVersion(options.version);

	let manifest;
	try {
		manifest = await readManifest(cwd);
	} catch (err) {
		if (err instanceof Error && /ENOENT/.test(err.message)) {
			throw new Error(
				`No ${MANIFEST_FILENAME} found in ${cwd}. Are you in a Poli Page project?`
			);
		}
		throw err;
	}

	if (!manifest.cloud?.projectId || !manifest.cloud.orgId) {
		throw new Error('Project is not linked. Run `poli link` first.');
	}

	if (!options.yes) {
		const ok = await (options.confirmOverwrite ?? defaultConfirm)(options.version);
		if (!ok) throw new Error('Checkout cancelled.');
	}

	const session = await getSessionToken(options.homeDir);
	const client = options.apiClient ?? createApiClient();

	const bundle = await client.downloadVersion(
		session,
		manifest.cloud.orgId,
		manifest.cloud.projectId,
		options.version
	);

	for (const file of bundle.templates) {
		const target = join(cwd, file.path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, file.content, 'utf-8');
	}

	for (const img of bundle.images ?? []) {
		const target = join(cwd, 'assets', 'images', img.path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, Buffer.from(img.data, 'base64'));
	}

	if (bundle.tailwindCss) {
		await writeFile(join(cwd, 'tailwind.css'), bundle.tailwindCss, 'utf-8');
	}

	const merged = {
		...(bundle.manifest as Record<string, unknown>),
		cloud: manifest.cloud,
	};
	await writeManifest(cwd, merged as Parameters<typeof writeManifest>[1]);
}

async function defaultConfirm(version: string): Promise<boolean> {
	const { confirm } = await import('@inquirer/prompts');
	return confirm({
		message: `Overwrite local files with version ${version}? Any uncommitted changes will be lost.`,
		default: false,
	});
}

export function registerCheckoutCommand(program: Command) {
	program
		.command('checkout')
		.description(
			'Restore a specific version of the project locally (overwrites local files)'
		)
		.argument('<version>', 'Exact semver version (e.g. 1.2.3)')
		.option('-y, --yes', 'Skip the overwrite confirmation prompt')
		.action(async (version: string, opts) => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');

			const spinner = ora(`Checking out ${version}...`).start();
			try {
				await executeCheckout({ version, yes: opts.yes });
				spinner.succeed(chalk.green(`Checked out version ${version}`));
				console.log();
				console.log(
					chalk.dim('  Tip: commit your local changes before checking out another version.')
				);
			} catch (error) {
				spinner.fail(
					chalk.red(error instanceof Error ? error.message : 'Checkout failed')
				);
				process.exitCode = 1;
			}
		});
}
