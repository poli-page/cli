import { Command } from 'commander';
import {
	resolveCloudContext,
	validateExactSemver,
} from '../cloud-context.js';
import type {
	ApiClient,
	VersionInfo,
	UnpromotePreview,
} from '../api-client.js';

export interface VersionStateOptions {
	cwd?: string;
	apiClient?: ApiClient;
	homeDir?: string;
	yes?: boolean;
	confirmFn?: (info: { action: string; version: string }) => Promise<boolean>;
}

export interface UnpromoteOptions {
	cwd?: string;
	apiClient?: ApiClient;
	homeDir?: string;
	yes?: boolean;
	force?: boolean;
	confirmFn?: (info: {
		action: string;
		version: string;
		preview: UnpromotePreview;
	}) => Promise<boolean>;
}

async function maybeConfirm(
	options: { yes?: boolean; confirmFn?: (info: never) => Promise<boolean> },
	info: { action: string; version: string; [k: string]: unknown }
): Promise<void> {
	if (options.yes) return;
	if (!options.confirmFn) return;
	const ok = await options.confirmFn(info as never);
	if (!ok) {
		throw new Error(`${info.action} cancelled.`);
	}
}

export async function executePromote(
	version: string,
	options: VersionStateOptions = {}
): Promise<VersionInfo> {
	validateExactSemver(version);
	const { client, ctx } = await resolveCloudContext(options);
	await maybeConfirm(options, { action: 'Promote', version });
	return client.promoteVersion(ctx.session, ctx.orgId, ctx.projectId, version);
}

export async function executeUnpromotePreview(
	version: string,
	options: VersionStateOptions = {}
): Promise<UnpromotePreview> {
	validateExactSemver(version);
	const { client, ctx } = await resolveCloudContext(options);
	return client.unpromotePreview(ctx.session, ctx.orgId, ctx.projectId, version);
}

export async function executeUnpromote(
	version: string,
	options: UnpromoteOptions = {}
): Promise<{ preview: UnpromotePreview; result: VersionInfo }> {
	validateExactSemver(version);
	const { client, ctx } = await resolveCloudContext(options);

	const preview = await client.unpromotePreview(
		ctx.session,
		ctx.orgId,
		ctx.projectId,
		version
	);

	if (!options.yes && options.confirmFn) {
		const ok = await options.confirmFn({
			action: 'Unpromote',
			version,
			preview,
		});
		if (!ok) {
			throw new Error('Unpromote cancelled.');
		}
	}

	const result = await client.unpromoteVersion(
		ctx.session,
		ctx.orgId,
		ctx.projectId,
		version,
		options.force ? { force: true } : undefined
	);
	return { preview, result };
}

export async function executeDeprecate(
	version: string,
	options: VersionStateOptions = {}
): Promise<VersionInfo> {
	validateExactSemver(version);
	const { client, ctx } = await resolveCloudContext(options);
	await maybeConfirm(options, { action: 'Deprecate', version });
	return client.deprecateVersion(ctx.session, ctx.orgId, ctx.projectId, version);
}

export async function executeUndeprecate(
	version: string,
	options: VersionStateOptions = {}
): Promise<VersionInfo> {
	validateExactSemver(version);
	const { client, ctx } = await resolveCloudContext(options);
	await maybeConfirm(options, { action: 'Un-deprecate', version });
	return client.undeprecateVersion(ctx.session, ctx.orgId, ctx.projectId, version);
}

async function defaultConfirm(message: string): Promise<boolean> {
	const { confirm } = await import('@inquirer/prompts');
	return confirm({ message, default: false });
}

export function registerVersionStateCommands(program: Command) {
	program
		.command('promote')
		.description('Promote a SANDBOX version to LIVE')
		.argument('<version>', 'Exact semver to promote')
		.option('-y, --yes', 'Skip the confirmation prompt')
		.action(async (version: string, opts) => {
			const { default: chalk } = await import('chalk');
			try {
				const result = await executePromote(version, {
					yes: opts.yes,
					confirmFn: async ({ action, version: v }) =>
						defaultConfirm(`${action} ${v} to LIVE?`),
				});
				console.log(chalk.green(`✓ Promoted ${result.version} to LIVE`));
			} catch (err) {
				console.error(
					chalk.red(err instanceof Error ? err.message : 'Promote failed')
				);
				process.exitCode = 1;
			}
		});

	program
		.command('unpromote')
		.description(
			'Move a LIVE version back to SANDBOX (shows usage preview before confirming)'
		)
		.argument('<version>', 'Exact semver to unpromote')
		.option('-y, --yes', 'Skip the confirmation prompt')
		.option('--force', 'Allow unpromoting the last LIVE version (dangerous)')
		.action(async (version: string, opts) => {
			const { default: chalk } = await import('chalk');
			try {
				const { preview, result } = await executeUnpromote(version, {
					yes: opts.yes,
					force: opts.force,
					confirmFn: async ({ version: v, preview: p }) => {
						console.log();
						console.log(chalk.bold('Unpromote preview:'));
						console.log(`  Current latest LIVE: ${p.currentLatestLive ?? '(none)'}`);
						console.log(
							`  After unpromote:    ${p.newLatestLiveAfterUnpromote ?? '(none)'}`
						);
						if (p.willHaveNoLive) {
							console.log(
								chalk.yellow(
									`  ⚠ No LIVE version will remain — production calls will fail.`
								)
							);
						}
						console.log(`  Live calls (24h):    ${p.recentLiveCalls}`);
						console.log();
						return defaultConfirm(`Unpromote ${v} from LIVE?`);
					},
				});
				console.log(
					chalk.green(`✓ Unpromoted ${result.version} (now SANDBOX)`)
				);
				if (preview.willHaveNoLive) {
					console.log(
						chalk.yellow(
							'  Note: no LIVE version remains for this project.'
						)
					);
				}
			} catch (err) {
				console.error(
					chalk.red(err instanceof Error ? err.message : 'Unpromote failed')
				);
				process.exitCode = 1;
			}
		});
}

export function registerVersionStateSubcommands(versionsGroup: Command) {
	versionsGroup
		.command('deprecate')
		.description('Mark a SANDBOX version as DEPRECATED')
		.argument('<version>', 'Exact semver to deprecate')
		.option('-y, --yes', 'Skip the confirmation prompt')
		.action(async (version: string, opts) => {
			const { default: chalk } = await import('chalk');
			try {
				const result = await executeDeprecate(version, {
					yes: opts.yes,
					confirmFn: async ({ version: v }) =>
						defaultConfirm(`Deprecate ${v}?`),
				});
				console.log(chalk.yellow(`✓ Deprecated ${result.version}`));
			} catch (err) {
				console.error(
					chalk.red(err instanceof Error ? err.message : 'Deprecate failed')
				);
				process.exitCode = 1;
			}
		});

	versionsGroup
		.command('un-deprecate')
		.description('Move a DEPRECATED version back to SANDBOX')
		.argument('<version>', 'Exact semver to un-deprecate')
		.option('-y, --yes', 'Skip the confirmation prompt')
		.action(async (version: string, opts) => {
			const { default: chalk } = await import('chalk');
			try {
				const result = await executeUndeprecate(version, {
					yes: opts.yes,
					confirmFn: async ({ version: v }) =>
						defaultConfirm(`Un-deprecate ${v}?`),
				});
				console.log(chalk.cyan(`✓ Un-deprecated ${result.version} (now SANDBOX)`));
			} catch (err) {
				console.error(
					chalk.red(err instanceof Error ? err.message : 'Un-deprecate failed')
				);
				process.exitCode = 1;
			}
		});
}
