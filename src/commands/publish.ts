import { Command } from 'commander';
import { readManifest, writeManifest } from '../manifest.js';
import { getSessionToken, readCredentials } from '../credentials.js';
import { createApiClient, type ApiClient, type VersionInfo } from '../api-client.js';
import { collectProjectPayload } from '../project-loader.js';
import { MANIFEST_FILENAME } from '../constants.js';

export interface PublishOptions {
	cwd?: string;
	apiClient?: ApiClient;
	homeDir?: string;
}

export async function executePublish(options: PublishOptions): Promise<VersionInfo> {
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

	// Resolve org ID from slug
	const orgs = await client.getOrganizations(session);
	const org = orgs.find((o) => o.slug === orgSlug);
	if (!org) {
		throw new Error(`Organization "${orgSlug}" not found.`);
	}

	// Sync draft to cloud
	const payload = await collectProjectPayload(cwd, manifest);
	await client.updateProject(session, org.id, projectId, payload);

	// Publish version
	const version = await client.publishVersion(session, org.id, projectId);

	// Update local manifest with published version
	manifest.project.version = version.version;
	await writeManifest(cwd, manifest);

	return version;
}

export function registerPublishCommand(program: Command) {
	program
		.command('publish')
		.description('Sync and publish a new version to the cloud')
		.action(async () => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');

			try {
				const spinner = ora('Syncing and publishing...').start();
				const version = await executePublish({});
				spinner.succeed(chalk.green(`Published version ${version.version}`));
			} catch (error) {
				console.error(
					chalk.red(error instanceof Error ? error.message : 'Publish failed'),
				);
				process.exitCode = 1;
			}
		});
}
