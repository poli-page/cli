import { Command } from 'commander';
import { readManifest, writeManifest } from '../manifest.js';
import { getSessionToken, readCredentials, updateOrgKeys } from '../credentials.js';
import { createApiClient, type ApiClient } from '../api-client.js';
import { MANIFEST_FILENAME } from '../constants.js';
import { collectProjectPayload } from '../project-loader.js';

export interface LinkOptions {
	cwd?: string;
	orgSlug: string;
	apiClient?: ApiClient;
	homeDir?: string;
}

export async function executeLink(options: LinkOptions): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const client = options.apiClient ?? createApiClient();

	// Verify authentication
	const session = await getSessionToken(options.homeDir);

	// Load manifest
	let manifest;
	try {
		manifest = await readManifest(cwd);
	} catch {
		throw new Error(`No ${MANIFEST_FILENAME} found in ${cwd}. Are you in a Poli Page project?`);
	}

	// Check if already linked
	if (manifest.cloud) {
		throw new Error(
			`Project is already linked to "${manifest.cloud.orgSlug}". Run "poli unlink" first.`
		);
	}

	// Fetch orgs to find the org ID
	const orgs = await client.getOrganizations(session);
	const org = orgs.find((o) => o.slug === options.orgSlug);
	if (!org) {
		const available = orgs.map((o) => o.slug).join(', ') || 'none';
		throw new Error(
			`Organization "${options.orgSlug}" not found. Available: ${available}`
		);
	}

	// Collect project payload (templates, assets, tailwind)
	const projectPayload = await collectProjectPayload(cwd, manifest);

	let projectId: string;
	const existingProjects = await client.listProjects(session, org.id);
	const projectSlug = manifest.project.name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	const existing = existingProjects.find((p) => p.slug === projectSlug);

	if (existing) {
		projectId = existing.id;
	} else {
		const created = await client.createProject(session, org.id, projectPayload);
		projectId = created.id;
	}

	// Ensure we have a test API key stored in credentials
	const credentials = await readCredentials(options.homeDir);
	if (!credentials?.orgs[options.orgSlug]?.testKey) {
		const apiKey = await client.createApiKey(session, org.id, 'CLI (test)', 'test');
		await updateOrgKeys(options.orgSlug, { testKey: apiKey.key }, options.homeDir);
	}

	// Update manifest with cloud config
	const apiUrl = process.env.POLI_API_URL;
	manifest.cloud = {
		orgSlug: options.orgSlug,
		projectId,
		...(apiUrl ? { apiUrl } : {}),
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
	} catch {
		throw new Error(`No ${MANIFEST_FILENAME} found in ${cwd}. Are you in a Poli Page project?`);
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
		.description('Link current project to a cloud organization')
		.action(async () => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');
			const { select } = await import('@inquirer/prompts');

			try {
				const credentials = await readCredentials();
				if (!credentials) {
					console.error(chalk.red('Not logged in. Run "poli login" first.'));
					process.exitCode = 1;
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
					process.exitCode = 1;
					return;
				}

				const orgSlug = await select({
					message: 'Select an organization:',
					choices: orgs.map((org) => ({
						name: `${org.name} (${org.slug})`,
						value: org.slug,
					})),
				});

				const spinner = ora('Linking project...').start();
				await executeLink({ orgSlug, apiClient: client });
				spinner.succeed(chalk.green(`Project linked to ${orgSlug}`));
			} catch (error) {
				console.error(
					chalk.red(error instanceof Error ? error.message : 'Link failed')
				);
				process.exitCode = 1;
			}
		});

	program
		.command('unlink')
		.description('Remove cloud association from current project')
		.action(async () => {
			const { default: chalk } = await import('chalk');
			try {
				await executeUnlink();
				console.log(chalk.green('Project unlinked from cloud.'));
			} catch (error) {
				console.error(
					chalk.red(error instanceof Error ? error.message : 'Unlink failed')
				);
				process.exitCode = 1;
			}
		});
}
