import { Command } from 'commander';
import { readManifest, writeManifest } from '../manifest.js';
import { getSessionToken } from '../credentials.js';
import {
	createApiClient,
	type ApiClient,
	type VersionInfo,
	type PushVersionBody,
} from '../api-client.js';
import { collectProjectPayload } from '../project-loader.js';
import { MANIFEST_FILENAME } from '../constants.js';
import { errorToExitCode } from '../exit-codes.js';

export type BumpType = 'patch' | 'minor' | 'major';

export interface PushOptions {
	cwd?: string;
	bump?: BumpType;
	message?: string;
	apiClient?: ApiClient;
	homeDir?: string;
}

export const PUSH_MESSAGE_MAX_LENGTH = 500;

export async function executePush(options: PushOptions = {}): Promise<VersionInfo> {
	const cwd = options.cwd ?? process.cwd();
	const bump: BumpType = options.bump ?? 'patch';

	if (options.message !== undefined && options.message.length > PUSH_MESSAGE_MAX_LENGTH) {
		throw new Error(
			`Push message is too long (${options.message.length} chars). Max is ${PUSH_MESSAGE_MAX_LENGTH}.`
		);
	}

	const session = await getSessionToken(options.homeDir);
	const client = options.apiClient ?? createApiClient();

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

	if (!manifest.cloud?.orgId || !manifest.cloud.projectId) {
		throw new Error('Project is not linked. Run `poli link` first.');
	}

	// Sync local content to the cloud draft so the snapshot reflects the current
	// state. Once `poli watch` is in place this becomes unnecessary, but for now
	// `push` is the only path that publishes local edits.
	const payload = await collectProjectPayload(cwd, manifest);
	await client.updateProject(
		session,
		manifest.cloud.orgId,
		manifest.cloud.projectId,
		payload
	);

	const body: PushVersionBody = {
		bumpType: bump,
		...(options.message ? { message: options.message } : {}),
	};
	const version = await client.pushVersion(
		session,
		manifest.cloud.orgId,
		manifest.cloud.projectId,
		body
	);

	manifest.project.version = version.version;
	await writeManifest(cwd, manifest);

	return version;
}

export function registerPushCommand(program: Command) {
	program
		.command('push')
		.description('Sync the local draft and push a new SANDBOX version')
		.option('--patch', 'Bump the patch number (default)')
		.option('--minor', 'Bump the minor number')
		.option('--major', 'Bump the major number')
		.option('-m, --message <text>', 'Optional push message (max 500 chars)')
		.action(async (opts) => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');

			let bump: BumpType = 'patch';
			if (opts.major) bump = 'major';
			else if (opts.minor) bump = 'minor';

			const spinner = ora('Pushing version...').start();
			try {
				const version = await executePush({ bump, message: opts.message });
				spinner.succeed(
					chalk.green(`Pushed version ${version.version} (SANDBOX)`)
				);
				console.log();
				console.log(
					`  ${chalk.dim('To make it live, run:')} ${chalk.cyan(`poli promote ${version.version}`)}`
				);
				console.log();
			} catch (error) {
				spinner.fail(
					chalk.red(error instanceof Error ? error.message : 'Push failed')
				);
				process.exitCode = errorToExitCode(error);
			}
		});
}
