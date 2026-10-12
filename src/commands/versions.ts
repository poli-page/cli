import { Command } from 'commander';
import {
	type ApiClient,
	type VersionInfo,
	type VersionState,
} from '../api-client.js';
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
}
