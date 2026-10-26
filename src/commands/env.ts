import { Command } from 'commander';
import {
	createApiClient,
	type EnvironmentInfo,
	type ProjectEnvironmentState,
	type PublishLogEntry,
} from '../api-client.js';
import { getSessionToken } from '../credentials.js';
import { UsageError, errorToExitCode } from '../exit-codes.js';
import { readManifest, type PoliPageManifest } from '../manifest.js';
import { shouldEmitJson } from '../output.js';
import { findOrganization, type Organization } from './link.js';
import { shortBundleHash } from './publish.js';

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
		`You belong to several organizations: ${orgs.map((o) => o.slug).join(', ')}. Pick one with --org <slug>.`
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

// ─── Output ─────────────────────────────────────────────────────────────────────

type ChalkFn = (s: string) => string;
type ChalkLike = Record<'dim' | 'green' | 'yellow' | 'red', ChalkFn>;

function yesNo(value: boolean): string {
	return value ? 'yes' : 'no';
}

function formatTimestamp(iso: string): string {
	return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function formatLastPublish(entry: PublishLogEntry | null, chalk: ChalkLike): string {
	if (!entry) return chalk.dim('not published');
	const status =
		entry.status === 'succeeded'
			? chalk.green(entry.status)
			: entry.status === 'failed'
				? chalk.red(`failed${entry.errorCode ? ` (${entry.errorCode})` : ''}`)
				: chalk.yellow(entry.status);
	return [
		status,
		formatTimestamp(entry.publishedAt ?? entry.startedAt),
		entry.author.displayName,
		shortBundleHash(entry.bundleHash),
		...(entry.message ? [entry.message] : []),
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
			e.environment,
			yesNo(e.protected),
			yesNo(e.readOnly),
			yesNo(e.published),
			formatLastPublish(e.lastPublish, chalk),
		]);
		return [
			`Environments of ${result.org}, project ${result.project}:`,
			'',
			...formatTable(
				['ENVIRONMENT', 'PROTECTED', 'READ-ONLY', 'PUBLISHED', 'LAST PUBLISH'],
				rows,
				chalk
			),
		];
	}
	const rows = result.environments.map((e) => [
		e.name,
		yesNo(e.protected),
		yesNo(e.readOnly),
		String(e.projectCount),
	]);
	return [
		`Environments of ${result.org}:`,
		'',
		...formatTable(['ENVIRONMENT', 'PROTECTED', 'READ-ONLY', 'PROJECTS'], rows, chalk),
	];
}

// ─── CLI registration ───────────────────────────────────────────────────────────

export function registerEnvCommands(program: Command) {
	const env = program.command('env').description("Inspect the organization's environments");

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
}
