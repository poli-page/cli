import { Command } from 'commander';
import { readManifest } from '../manifest.js';
import { getSessionToken } from '../credentials.js';
import {
	ApiError,
	createApiClient,
	EnvironmentNotFoundError,
	EnvironmentProtectedError,
	type ApiClient,
	type EnvironmentInfo,
	type PublishBody,
	type PublishResult,
} from '../api-client.js';
import { MANIFEST_FILENAME } from '../constants.js';
import { ExitCode, errorToExitCode } from '../exit-codes.js';
import { shouldEmitJson } from '../output.js';
import { toProjectFileEntries } from '../project-files.js';
import { readAllProjectFiles } from '../project-sync.js';

export interface PublishOptions {
	cwd?: string;
	env?: string;
	message?: string;
	yes?: boolean;
	apiClient?: ApiClient;
	homeDir?: string;
	/** Asks before publishing to a protected environment; absent without a TTY. */
	confirmFn?: (environment: string) => Promise<boolean>;
}

const MESSAGE_MAX_LENGTH = 500;
const BUNDLE_MAX_BYTES = 5 * 1024 * 1024;
const ENVIRONMENT_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ENVIRONMENT_NAME_MAX_LENGTH = 20;

class PublishUsageError extends Error {
	readonly exitCode = ExitCode.INVALID_USAGE;
}

function validateEnvironmentName(name: string | undefined): string {
	if (name === undefined) {
		throw new PublishUsageError(
			'--env is required: name the environment to publish to (for example `--env sandbox`).'
		);
	}
	if (name === 'draft') {
		throw new PublishUsageError(
			'`draft` is not an environment: `poli watch` and `poli dev` sync the draft. Publish to an environment such as `sandbox` or `live`.'
		);
	}
	if (name.length > ENVIRONMENT_NAME_MAX_LENGTH || !ENVIRONMENT_NAME_RE.test(name)) {
		throw new PublishUsageError(
			`Invalid environment name "${name}": use 1-20 characters, lowercase letters, digits and single inner hyphens, starting with a letter.`
		);
	}
	return name;
}

function environmentNotFound(
	name: string,
	known: EnvironmentInfo[] = []
): EnvironmentNotFoundError {
	const list = known.length > 0 ? ` Environments: ${known.map((e) => e.name).join(', ')}.` : '';
	return new EnvironmentNotFoundError(
		`Environment "${name}" does not exist in this organization.${list}`
	);
}

export async function executePublish(options: PublishOptions): Promise<PublishResult> {
	const cwd = options.cwd ?? process.cwd();
	const environment = validateEnvironmentName(options.env);
	if (options.message !== undefined && options.message.length > MESSAGE_MAX_LENGTH) {
		throw new PublishUsageError(
			`Publish message is too long (${options.message.length} characters). The maximum is ${MESSAGE_MAX_LENGTH}.`
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
	const orgId = manifest.cloud?.orgId;
	const project = manifest.cloud?.projectSlug;
	if (!orgId || !project) {
		throw new Error('Project is not linked. Run `poli link` first.');
	}

	const body: PublishBody = {
		environment,
		...(options.message ? { message: options.message } : {}),
		files: toProjectFileEntries(await readAllProjectFiles(cwd)),
	};
	const bodyBytes = Buffer.byteLength(JSON.stringify(body));
	if (bodyBytes > BUNDLE_MAX_BYTES) {
		throw new PublishUsageError(
			`The publish bundle is ${(bodyBytes / (1024 * 1024)).toFixed(1)} MiB; the limit is 5 MiB. Shrink or remove large assets.`
		);
	}

	const environments = await client.listEnvironments(session, orgId);
	const target = environments.find((e) => e.name === environment);
	if (!target) {
		throw environmentNotFound(environment, environments);
	}

	const yes = options.yes === true || process.env.CI === 'true';
	if (target.protected && !yes) {
		if (!options.confirmFn) {
			throw new PublishUsageError(
				`Environment "${environment}" is protected. Pass --yes to publish to it without a prompt.`
			);
		}
		if (!(await options.confirmFn(environment))) {
			throw new Error('Publish cancelled.');
		}
	}

	try {
		return await client.publish(session, orgId, project, body);
	} catch (err) {
		if (err instanceof EnvironmentProtectedError) {
			throw new EnvironmentProtectedError(
				`Environment "${environment}" is protected: only an owner or admin of the organization can publish to it.`
			);
		}
		if (err instanceof EnvironmentNotFoundError) {
			throw environmentNotFound(environment);
		}
		if (err instanceof ApiError && err.code === 'PUBLISH_IN_PROGRESS') {
			throw new ApiError(
				err.code,
				err.httpStatus,
				`Another publish of ${project} to "${environment}" is running. Wait for it to finish, then publish again.`,
				err.retryAfter
			);
		}
		throw err;
	}
}

async function defaultConfirm(environment: string): Promise<boolean> {
	const { confirm } = await import('@inquirer/prompts');
	return confirm({
		message: `"${environment}" is a protected environment. Publish to it?`,
		default: false,
	});
}

export function registerPublishCommand(program: Command) {
	program
		.command('publish')
		.description('Publish the local project to an environment')
		.option('--env <name>', 'Environment to publish to (required), for example sandbox or live')
		.option('-m, --message <text>', 'Publish message, kept in the publish log (max 500 chars)')
		.option('-y, --yes', 'Publish to a protected environment without the prompt')
		.option('--json', 'Force JSON output even in a TTY')
		.action(async (opts) => {
			const { default: chalk } = await import('chalk');
			const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
			try {
				const result = await executePublish({
					env: opts.env,
					message: opts.message,
					yes: opts.yes,
					confirmFn: interactive ? defaultConfirm : undefined,
				});

				if (shouldEmitJson(opts)) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}
				const shortHash = result.bundleHash.replace(/^sha256:/, '').slice(0, 12);
				console.log(chalk.green(`✓ Published ${result.project} to ${result.environment}`));
				console.log(`  ${chalk.dim('Bundle:')}  ${shortHash} (${result.fileCount} files)`);
				console.log(`  ${chalk.dim('Log id:')}  ${result.logId}`);
			} catch (err) {
				console.error(chalk.red(err instanceof Error ? err.message : 'Publish failed'));
				process.exitCode = errorToExitCode(err);
			}
		});
}
