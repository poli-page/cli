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
import { shouldEmitJson } from '../output.js';

export type BumpType = 'patch' | 'minor' | 'major';

export interface PushOptions {
	cwd?: string;
	bump?: BumpType;
	message?: string;
	/**
	 * Explicit version mode (api-spec §9.1). Mutually exclusive with `bump`
	 * and `track`. The server returns 409 VERSION_CONFLICT if it already
	 * exists in any state.
	 */
	version?: string;
	/**
	 * Override the manifest's `cloud.track`. Useful for CI/CD where the
	 * manifest may not have been checked out from the right family. Format
	 * is `major.minor` (e.g. "1.0").
	 */
	track?: string;
	apiClient?: ApiClient;
	homeDir?: string;
}

export const PUSH_MESSAGE_MAX_LENGTH = 500;

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;
const PARTIAL_SEMVER = /^\d+(?:\.\d+)?$/;
const TRACK_RE = /^\d+\.\d+$/;

function validateExplicitVersion(version: string): void {
	if (version === 'latest') {
		throw new Error(
			'`latest` was retired. Use an exact semver `X.Y.Z` with --version.'
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

export async function executePush(options: PushOptions = {}): Promise<VersionInfo> {
	const cwd = options.cwd ?? process.cwd();

	// Mutually-exclusive flags (api-spec §9.1)
	if (options.version && options.bump) {
		throw new Error('Use either --version or --bump (--patch / --minor / --major), not both.');
	}
	if (options.version && options.track) {
		throw new Error('--version and --track are mutually exclusive (--version sets the version explicitly).');
	}
	if (options.version) {
		validateExplicitVersion(options.version);
	}
	if (options.track && !TRACK_RE.test(options.track)) {
		throw new Error('Track must be `major.minor` (e.g. "1.0").');
	}

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

	// Build the body: explicit `{version}` shape OR bump-driven `{bumpType, track?}`.
	// Track precedence: --track flag > manifest.cloud.track > undefined.
	let body: PushVersionBody;
	if (options.version) {
		body = {
			version: options.version,
			...(options.message ? { message: options.message } : {}),
		};
	} else {
		const bump: BumpType = options.bump ?? 'patch';
		const track = options.track ?? manifest.cloud.track;
		body = {
			bumpType: bump,
			...(track ? { track } : {}),
			...(options.message ? { message: options.message } : {}),
		};
	}

	const version = await client.pushVersion(
		session,
		manifest.cloud.orgId,
		manifest.cloud.projectId,
		body
	);

	// Post-push: update both project.version and cloud.track to reflect the
	// new state (api-spec §9.1 — cycle of life of `cloud.track`). Patch on
	// the same family keeps the same major.minor and the assignment is a
	// no-op; minor/major/explicit-version naturally produce a new track.
	manifest.project.version = version.version;
	manifest.cloud.track = `${version.major}.${version.minor}`;
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
		.option(
			'--version <X.Y.Z>',
			'Push an explicit version (mutually exclusive with --patch/--minor/--major)'
		)
		.option(
			'--track <X.Y>',
			'Override the manifest cloud.track (CI use). Anchors --patch/--minor on this family.'
		)
		.option('-m, --message <text>', 'Optional push message (max 500 chars)')
		.option('--json', 'Force JSON output even in a TTY')
		.action(async (opts) => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');

			let bump: BumpType | undefined;
			if (opts.major) bump = 'major';
			else if (opts.minor) bump = 'minor';
			else if (opts.patch) bump = 'patch';

			const emitJson = shouldEmitJson(opts);
			const spinner = emitJson ? null : ora('Pushing version...').start();
			try {
				const version = await executePush({
					bump,
					version: opts.version,
					track: opts.track,
					message: opts.message,
				});

				if (emitJson) {
					console.log(JSON.stringify(version, null, 2));
					return;
				}

				spinner!.succeed(
					chalk.green(`Pushed version ${version.version} (SANDBOX)`)
				);
				console.log();
				console.log(
					`  ${chalk.dim('To make it live, run:')} ${chalk.cyan(`poli promote ${version.version}`)}`
				);
				console.log();
			} catch (error) {
				if (spinner) {
					spinner.fail(
						chalk.red(error instanceof Error ? error.message : 'Push failed')
					);
				} else {
					console.error(
						chalk.red(error instanceof Error ? error.message : 'Push failed')
					);
				}
				process.exitCode = errorToExitCode(error);
			}
		});
}
