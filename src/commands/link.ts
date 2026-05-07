import { Command } from 'commander';
import { readManifest, writeManifest } from '../manifest.js';
import { getSessionToken, readCredentials } from '../credentials.js';
import { createApiClient, type ApiClient } from '../api-client.js';
import { collectProjectPayload } from '../project-loader.js';
import { MANIFEST_FILENAME } from '../constants.js';
import { errorToExitCode, ExitCode } from '../exit-codes.js';

export interface LinkOptions {
	cwd?: string;
	orgSlug: string;
	apiClient?: ApiClient;
	homeDir?: string;
}

function toKebabCase(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export async function executeLink(options: LinkOptions): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const client = options.apiClient ?? createApiClient();
	const session = await getSessionToken(options.homeDir);

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

	if (manifest.cloud) {
		throw new Error(
			`Project is already linked to "${manifest.cloud.orgSlug}". Run "poli unlink" first.`
		);
	}

	const orgs = await client.getOrganizations(session);
	const org = orgs.find((o) => o.slug === options.orgSlug);
	if (!org) {
		const available = orgs.map((o) => o.slug).join(', ') || 'none';
		throw new Error(
			`Organization "${options.orgSlug}" not found. Available: ${available}`
		);
	}

	const projectSlug = toKebabCase(manifest.project.name);
	const existingProjects = await client.listProjects(session, org.id);
	const existing = existingProjects.find((p) => p.slug === projectSlug);

	let projectId: string;
	if (existing) {
		projectId = existing.id;
	} else {
		// The API expects the full project bundle (manifest + templates +
		// optional images + tailwind) — same payload shape as `updateProject`.
		// The server derives the slug from `manifest.project.name`.
		const payload = await collectProjectPayload(cwd, manifest);
		const created = await client.createProject(session, org.id, payload);
		projectId = created.id;
	}

	manifest.cloud = {
		orgSlug: options.orgSlug,
		orgId: org.id,
		projectSlug,
		projectId,
	};

	await writeManifest(cwd, manifest);
}

export interface UnlinkOptions {
	cwd?: string;
}

export async function executeUnlink(options: UnlinkOptions = {}): Promise<void> {
	const cwd = options.cwd ?? process.cwd();

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

	if (!manifest.cloud) {
		throw new Error('Project is not linked to any organization.');
	}

	delete manifest.cloud;
	await writeManifest(cwd, manifest);
}

export function registerLinkCommands(program: Command) {
	program
		.command('link')
		.description('Link the current project to a cloud organization')
		.action(async () => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');
			const { select } = await import('@inquirer/prompts');

			let spinner: ReturnType<typeof ora> | undefined;
			try {
				const credentials = await readCredentials();
				if (!credentials) {
					console.error(chalk.red('Not logged in. Run "poli login" first.'));
					process.exitCode = ExitCode.NOT_AUTHENTICATED;
					return;
				}

				const client = createApiClient();
				const orgs = await client.getOrganizations(credentials.session);

				if (orgs.length === 0) {
					console.error(
						chalk.red(
							'No organizations found. Create one via the dashboard first.'
						)
					);
					process.exitCode = ExitCode.INVALID_LOCAL_STATE;
					return;
				}

				const orgSlug = await select({
					message: 'Select an organization:',
					choices: orgs.map((org) => ({
						name: `${org.name} (${org.slug})`,
						value: org.slug,
					})),
				});

				spinner = ora('Linking project...').start();
				await executeLink({ orgSlug, apiClient: client });
				spinner.succeed(chalk.green(`Project linked to ${orgSlug}`));
			} catch (error) {
				const msg = error instanceof Error ? error.message : 'Link failed';
				if (spinner) {
					spinner.fail(chalk.red(msg));
				} else {
					console.error(chalk.red(msg));
				}
				process.exitCode = errorToExitCode(error);
			}
		});

	program
		.command('unlink')
		.description('Remove the cloud association from the current project')
		.action(async () => {
			const { default: chalk } = await import('chalk');
			try {
				await executeUnlink();
				console.log(chalk.green('Project unlinked from cloud.'));
			} catch (error) {
				console.error(
					chalk.red(error instanceof Error ? error.message : 'Unlink failed')
				);
				process.exitCode = errorToExitCode(error);
			}
		});
}
