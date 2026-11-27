import { Command } from 'commander';
import { readProjectManifest, readProjectManifestJson, writeManifest } from '../manifest.js';
import { parseManifestWithoutCloud } from '../manifest.schema.js';
import { getSessionToken, readCredentials, sessionFor } from '../credentials.js';
import { createApiClient, type ApiClient } from '../api-client.js';
import { collectProjectPayload } from '../project-loader.js';
import {
	confirmExistingProjectPrompt,
	forgetLink,
	recordLink,
	UnconfirmedLinkError,
	type LinkTarget,
} from '../cloud-link.js';
import { errorToExitCode, ExitCode } from '../exit-codes.js';
import { oneLine } from '../output.js';

export interface LinkOptions {
	cwd?: string;
	orgSlug: string;
	apiClient?: ApiClient;
	homeDir?: string;
	/** Link to a project of the same slug without asking (`--existing`). */
	existing?: boolean;
	/** Asks before linking to a project of the same slug; absent when nobody can answer. */
	confirmExisting?: (target: LinkTarget) => Promise<boolean>;
}

function toKebabCase(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export interface Organization {
	id: string;
	name: string;
	slug: string;
}

export function findOrganization(orgs: Organization[], slug: string): Organization {
	const org = orgs.find((o) => o.slug === slug);
	if (!org) {
		const available = orgs.map((o) => oneLine(o.slug)).join(', ') || 'none';
		throw new Error(`Organization "${oneLine(slug)}" not found. Available: ${available}`);
	}
	return org;
}

/** Interactive organization picker (TTY only); resolves to the chosen slug. */
export async function promptForOrganization(
	orgs: Organization[],
	message = 'Select an organization:'
): Promise<string> {
	const { select } = await import('@inquirer/prompts');
	return select({
		message,
		choices: orgs.map((org) => ({
			name: `${oneLine(org.name)} (${oneLine(org.slug)})`,
			value: org.slug,
		})),
	});
}

export async function executeLink(options: LinkOptions): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const client = options.apiClient ?? createApiClient();
	const session = await getSessionToken(options.homeDir);

	const manifest = await readProjectManifest(cwd);

	if (manifest.cloud) {
		throw new Error(
			`Project is already linked to "${manifest.cloud.orgSlug}". Run "poli unlink" first.`
		);
	}

	const orgs = await client.getOrganizations(session);
	const org = findOrganization(orgs, options.orgSlug);

	const projectSlug = toKebabCase(manifest.project.name);
	const existingProjects = await client.listProjects(session, org.id);
	const existing = existingProjects.find((p) => p.slug === projectSlug);

	let projectId: string;
	if (existing) {
		// Another project of that slug is someone's draft: every later sync overwrites it.
		if (!options.existing) {
			const target = { org, project: existing };
			if (!options.confirmExisting) {
				throw new UnconfirmedLinkError(
					`Organization "${oneLine(org.slug)}" already has a project "${oneLine(existing.name)}" (${existing.slug}). Re-run with \`--existing\` to link this folder to it, or in a terminal to be asked.`
				);
			}
			if (!(await options.confirmExisting(target))) {
				throw new Error('Link cancelled: the folder was left unlinked.');
			}
		}
		projectId = existing.id;
	} else {
		// The API expects the full project bundle (manifest + templates +
		// optional images + tailwind).
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
	// The user chose this link: `poli dev` / `poli watch` sync it without asking.
	await recordLink(cwd, projectId, options.homeDir);
}

export interface UnlinkOptions {
	cwd?: string;
	homeDir?: string;
}

export async function executeUnlink(options: UnlinkOptions = {}): Promise<void> {
	const cwd = options.cwd ?? process.cwd();

	// The block being removed may be the invalid part: it must not block its own removal.
	const raw = await readProjectManifestJson(cwd);
	const manifest = parseManifestWithoutCloud(raw);

	if ((raw as Record<string, unknown>).cloud === undefined) {
		throw new Error('Project is not linked to any organization.');
	}

	// Forget first: once the cloud block is gone, `poli unlink` cannot be retried.
	await forgetLink(cwd, options.homeDir);
	await writeManifest(cwd, manifest);
}

export function registerLinkCommands(program: Command) {
	program
		.command('link')
		.description('Link the current project to a cloud organization')
		.option(
			'--existing',
			'Link to the project of the same name if the organization already has one, without asking'
		)
		.action(async (opts: { existing?: boolean }) => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');

			let spinner: ReturnType<typeof ora> | undefined;
			try {
				const credentials = await readCredentials();
				if (!credentials) {
					console.error(chalk.red('Not logged in. Run "poli login" first.'));
					process.exitCode = ExitCode.NOT_AUTHENTICATED;
					return;
				}

				const client = createApiClient();
				const orgs = await client.getOrganizations(sessionFor(credentials));

				if (orgs.length === 0) {
					console.error(
						chalk.red('No organizations found. Create one via the dashboard first.')
					);
					process.exitCode = ExitCode.INVALID_LOCAL_STATE;
					return;
				}

				const orgSlug = await promptForOrganization(orgs);

				spinner = ora('Linking project...').start();
				const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
				await executeLink({
					orgSlug,
					apiClient: client,
					existing: opts.existing,
					confirmExisting: interactive
						? (target) => {
								spinner?.stop();
								return confirmExistingProjectPrompt(target);
							}
						: undefined,
				});
				spinner.succeed(chalk.green(`Project linked to ${oneLine(orgSlug)}`));
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
				console.error(chalk.red(error instanceof Error ? error.message : 'Unlink failed'));
				process.exitCode = errorToExitCode(error);
			}
		});
}
