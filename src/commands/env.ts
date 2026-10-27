import { Command } from 'commander';
import {
	ApiError,
	createApiClient,
	InsufficientRoleError,
	type EnvironmentInfo,
	type ProjectEnvironmentState,
	type PublishLogEntry,
} from '../api-client.js';
import { getSessionToken } from '../credentials.js';
import { assertEnvironmentName } from '../environment-name.js';
import { UsageError, errorToExitCode } from '../exit-codes.js';
import { readManifest, type PoliPageManifest } from '../manifest.js';
import { shouldEmitJson } from '../output.js';
import { findOrganization, type Organization } from './link.js';
import { shortBundleHash } from './publish.js';
import { inputPrompt } from '../template-prompt.js';

type EnvListResult =
	| { scope: 'project'; org: string; project: string; environments: ProjectEnvironmentState[] }
	| { scope: 'organization'; org: string; environments: EnvironmentInfo[] };

/** The manifest's `cloud` block, or `undefined` when the folder has no poli-page.json. */
async function readLinkedProject(cwd: string): Promise<PoliPageManifest['cloud']> {
	try {
		return (await readManifest(cwd)).cloud;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw err;
	}
}

function selectOrganization(
	orgs: Organization[],
	flag: string | undefined,
	linkedSlug: string | undefined
): Organization {
	if (flag !== undefined) {
		try {
			return findOrganization(orgs, flag);
		} catch (err) {
			throw new UsageError((err as Error).message);
		}
	}
	if (linkedSlug !== undefined) return findOrganization(orgs, linkedSlug);
	if (orgs.length === 1) return orgs[0];
	if (orgs.length === 0) {
		throw new Error('Your account has no organization yet. Create one in the dashboard.');
	}
	throw new UsageError(
		`You belong to several organizations: ${orgs.map((o) => oneLine(o.slug)).join(', ')}. Pick one with --org <slug>.`
	);
}

/** `orgFlag` is `--org`; without it, the linked organization, else the only one. */
async function executeEnvList(orgFlag: string | undefined): Promise<EnvListResult> {
	const session = await getSessionToken();
	const client = createApiClient();
	const linked = await readLinkedProject(process.cwd());

	const orgs = await client.getOrganizations(session);
	const org = selectOrganization(orgs, orgFlag, linked?.orgSlug);

	if (linked && linked.orgSlug === org.slug) {
		return {
			scope: 'project',
			org: org.slug,
			project: linked.projectSlug ?? linked.projectId,
			environments: await client.getProjectEnvironments(session, org.id, linked.projectId),
		};
	}
	return {
		scope: 'organization',
		org: org.slug,
		environments: await client.listEnvironments(session, org.id),
	};
}

interface RemoveProjectResult {
	org: string;
	project: string;
	environment: string;
}

/** The API's removal errors, reworded with the project and environment they are about. */
function explainRemoveError(err: unknown, project: string, environment: string): unknown {
	if (!(err instanceof ApiError)) return err;
	const reworded = (message: string) =>
		new ApiError(err.code, err.httpStatus, message, err.retryAfter);
	switch (err.code) {
		case 'INSUFFICIENT_ROLE':
			return new InsufficientRoleError(
				'Owner or admin required: only an owner or admin of the organization can remove a project from an environment.'
			);
		case 'PROJECT_NOT_IN_ENVIRONMENT':
			return new UsageError(
				`Project ${project} is not published in "${environment}": there is nothing to remove.`
			);
		case 'ENVIRONMENT_NOT_FOUND':
			return new UsageError(
				`This organization has no environment "${environment}", so ${project} cannot be removed from it.`
			);
		case 'PUBLISH_IN_PROGRESS':
			return reworded(
				`A publish or removal of ${project} in "${environment}" is running. Wait for it to finish, then try again.`
			);
		case 'TRANSFER_IN_PROGRESS':
			return reworded(
				`${project} is being transferred to another organization. Try again once the transfer is done.`
			);
		case 'ENVIRONMENT_READ_ONLY':
			return reworded(
				`Environment "${environment}" is read-only: the organization's plan no longer covers it.`
			);
		default:
			return err;
	}
}

/**
 * Removes the linked project from `environment` once the user has typed its
 * slug at `typeProjectName` (absent without a TTY) or passed `--yes`;
 * nothing is sent before that.
 */
async function executeEnvRemoveProject(
	environment: string,
	options: { yes?: boolean; typeProjectName?: (message: string) => Promise<string> }
): Promise<RemoveProjectResult> {
	assertEnvironmentName(
		environment,
		'`draft` is not an environment: a project cannot be removed from its draft.'
	);
	const session = await getSessionToken();
	const linked = await readLinkedProject(process.cwd());
	if (!linked) {
		throw new Error('This folder is not linked to a project. Run `poli link` first.');
	}
	const project = linked.projectSlug ?? linked.projectId;
	const shown = oneLine(project);

	if (!options.yes) {
		if (!options.typeProjectName) {
			throw new UsageError(
				`Removing ${shown} from "${environment}" asks you to type the project slug. Without a terminal, pass --yes.`
			);
		}
		const typed = await options.typeProjectName(
			`This deletes the copy of ${shown} published in "${environment}"; its documents are kept. Type the project slug (${shown}) to confirm:`
		);
		if (typed.trim() !== project) {
			throw new Error(`What you typed is not "${shown}". Nothing was removed.`);
		}
	}

	const client = createApiClient();
	const orgs = await client.getOrganizations(session);
	const org = selectOrganization(orgs, undefined, linked.orgSlug);
	try {
		await client.removeProjectFromEnvironment(session, org.id, linked.projectId, environment);
	} catch (err) {
		throw explainRemoveError(err, shown, environment);
	}
	return { org: org.slug, project, environment };
}

function typeProjectName(message: string): Promise<string> {
	return inputPrompt({ message });
}

// ─── Output ─────────────────────────────────────────────────────────────────────

type ChalkFn = (s: string) => string;
type ChalkLike = Record<'dim' | 'green' | 'yellow' | 'red', ChalkFn>;

function yesNo(value: boolean): string {
	return value ? 'yes' : 'no';
}

function formatTimestamp(iso: string): string {
	return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Server text on one table line: a newline or escape sequence would forge rows. */
function oneLine(text: string): string {
	return text.replace(/\p{Cc}+/gu, ' ');
}

function formatLastPublish(entry: PublishLogEntry | null, chalk: ChalkLike): string {
	if (!entry) return chalk.dim('not published');
	const status =
		entry.status === 'succeeded'
			? chalk.green(entry.status)
			: entry.status === 'failed'
				? chalk.red(`failed${entry.errorCode ? ` (${oneLine(entry.errorCode)})` : ''}`)
				: chalk.yellow(oneLine(entry.status));
	return [
		status,
		formatTimestamp(entry.publishedAt ?? entry.startedAt),
		oneLine(entry.author.displayName),
		oneLine(shortBundleHash(entry.bundleHash)),
		...(entry.message ? [oneLine(entry.message)] : []),
	].join('  ');
}

/** Pads every column but the last to its widest cell, two spaces apart. */
function formatTable(header: string[], rows: string[][], chalk: ChalkLike): string[] {
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
	const line = (cells: string[]) =>
		`  ${cells.map((c, i) => (i < cells.length - 1 ? c.padEnd(widths[i]) : c)).join('  ')}`;
	return [chalk.dim(line(header)), ...rows.map(line)];
}

function formatEnvList(result: EnvListResult, chalk: ChalkLike): string[] {
	if (result.scope === 'project') {
		const rows = result.environments.map((e) => [
			oneLine(e.environment),
			yesNo(e.protected),
			yesNo(e.readOnly),
			yesNo(e.published),
			formatLastPublish(e.lastPublish, chalk),
		]);
		return [
			`Environments of ${oneLine(result.org)}, project ${oneLine(result.project)}:`,
			'',
			...formatTable(
				['ENVIRONMENT', 'PROTECTED', 'READ-ONLY', 'PUBLISHED', 'LAST PUBLISH'],
				rows,
				chalk
			),
		];
	}
	const rows = result.environments.map((e) => [
		oneLine(e.name),
		yesNo(e.protected),
		yesNo(e.readOnly),
		String(e.projectCount),
	]);
	return [
		`Environments of ${oneLine(result.org)}:`,
		'',
		...formatTable(['ENVIRONMENT', 'PROTECTED', 'READ-ONLY', 'PROJECTS'], rows, chalk),
	];
}

// ─── CLI registration ───────────────────────────────────────────────────────────

export function registerEnvCommands(program: Command) {
	const env = program
		.command('env')
		.description("Inspect the organization's environments, and remove a project from one");

	env.command('list')
		.description(
			"List the environments; in a linked folder, with the project's last publish in each"
		)
		.option(
			'--org <slug>',
			'Organization to list (default: the linked one, else your only one)'
		)
		.option('--json', 'Force JSON output even in a TTY')
		.action(async (opts: { org?: string; json?: boolean }) => {
			const { default: chalk } = await import('chalk');
			try {
				const result = await executeEnvList(opts.org);
				if (shouldEmitJson(opts)) {
					console.log(JSON.stringify(result.environments, null, 2));
					return;
				}
				for (const line of formatEnvList(result, chalk)) console.log(line);
			} catch (err) {
				console.error(chalk.red(err instanceof Error ? err.message : 'Failed'));
				process.exitCode = errorToExitCode(err);
			}
		});

	env.command('remove-project <environment>')
		.description(
			'Remove the linked project from an environment (owner or admin); its documents are kept'
		)
		.option('-y, --yes', 'Remove without typing the project slug to confirm')
		.option('--json', 'Force JSON output even in a TTY')
		.action(async (environment: string, opts: { yes?: boolean; json?: boolean }) => {
			const { default: chalk } = await import('chalk');
			const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
			try {
				const result = await executeEnvRemoveProject(environment, {
					yes: opts.yes,
					typeProjectName: interactive ? typeProjectName : undefined,
				});
				if (shouldEmitJson(opts)) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}
				console.log(
					chalk.green(
						`✓ Removed ${oneLine(result.project)} from "${environment}". Its documents are kept; \`poli publish --env ${environment}\` adds it back.`
					)
				);
			} catch (err) {
				console.error(chalk.red(err instanceof Error ? err.message : 'Failed'));
				process.exitCode = errorToExitCode(err);
			}
		});
}
