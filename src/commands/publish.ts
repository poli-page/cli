import { Command } from 'commander';
import { readProjectManifest } from '../manifest.js';
import { resolveAuth, SESSION_IGNORED_HINT, type AuthContext } from '../auth.js';
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
import { assertEnvironmentName } from '../environment-name.js';
import { ExitCode, UsageError, errorToExitCode } from '../exit-codes.js';
import { shouldEmitJson } from '../output.js';
import { toProjectFileEntries } from '../project-files.js';
import { readAllProjectFiles } from '../project-sync.js';
import { confirmPrompt } from '../template-prompt.js';
import { verifyCloudLink, type CloudBlock } from '../cloud-link.js';

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

/** The API's result, plus which credential made the call. */
export interface PublishOutcome extends PublishResult {
	credential: AuthContext['mode'];
}

const MESSAGE_MAX_LENGTH = 500;
const BUNDLE_MAX_BYTES = 5 * 1024 * 1024;

class PublishNotAuthorizedError extends Error {
	readonly exitCode = ExitCode.NOT_AUTHORIZED;
}

function validateEnvironmentName(name: string | undefined): string {
	if (name === undefined) {
		throw new UsageError(
			'--env is required: name the environment to publish to (for example `--env sandbox`).'
		);
	}
	assertEnvironmentName(
		name,
		'`draft` is not an environment: `poli watch` and `poli dev` sync the draft. Publish to an environment such as `sandbox` or `live`.'
	);
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

async function buildPublishBody(
	cwd: string,
	environment: string,
	message: string | undefined
): Promise<PublishBody> {
	const body: PublishBody = {
		environment,
		...(message ? { message } : {}),
		files: toProjectFileEntries(await readAllProjectFiles(cwd)),
	};
	const bodyBytes = Buffer.byteLength(JSON.stringify(body));
	if (bodyBytes > BUNDLE_MAX_BYTES) {
		throw new UsageError(
			`The publish bundle is ${(bodyBytes / (1024 * 1024)).toFixed(1)} MiB; the limit is 5 MiB. Shrink or remove large assets.`
		);
	}
	return body;
}

async function confirmProtected(target: EnvironmentInfo, options: PublishOptions): Promise<void> {
	if (!target.protected || options.yes === true) return;
	if (!options.confirmFn) {
		throw new UsageError(
			`Environment "${target.name}" is protected. Pass --yes to publish to it without a prompt.`
		);
	}
	if (!(await options.confirmFn(target.name))) {
		throw new Error('Publish cancelled.');
	}
}

/** The API's publish errors, reworded with the project and environment they are about. */
function explainPublishError(
	err: unknown,
	project: string,
	environment: string,
	environments: EnvironmentInfo[]
): unknown {
	if (err instanceof EnvironmentProtectedError) {
		return new EnvironmentProtectedError(
			`Environment "${environment}" is protected: only an owner or admin of the organization can publish to it.`
		);
	}
	if (err instanceof EnvironmentNotFoundError) {
		// The preflight list still holds the environment the API just reported gone.
		return environmentNotFound(
			environment,
			environments.filter((e) => e.name !== environment)
		);
	}
	if (err instanceof ApiError && err.code === 'PUBLISH_IN_PROGRESS') {
		return new ApiError(
			err.code,
			err.httpStatus,
			`Another publish of ${project} to "${environment}" is running. Wait for it to finish, then publish again.`,
			err.retryAfter
		);
	}
	return err;
}

export async function executePublish(options: PublishOptions): Promise<PublishOutcome> {
	const cwd = options.cwd ?? process.cwd();
	const environment = validateEnvironmentName(options.env);
	if (options.message !== undefined && options.message.length > MESSAGE_MAX_LENGTH) {
		throw new UsageError(
			`Publish message is too long (${options.message.length} characters). The maximum is ${MESSAGE_MAX_LENGTH}.`
		);
	}

	const { cloud } = await readProjectManifest(cwd);
	const project = cloud?.projectSlug;
	if (!cloud || !project) {
		throw new Error('Project is not linked. Run `poli link` first.');
	}

	const auth = await resolveAuth({
		manifestOrgId: cloud.orgId,
		homeDir: options.homeDir,
	});
	const client = options.apiClient ?? createApiClient();
	if (auth.mode === 'api-key') {
		const result = await publishWithApiKey(
			cwd,
			environment,
			options,
			client,
			auth,
			project,
			cloud
		);
		return { ...result, credential: auth.mode };
	}

	const body = await buildPublishBody(cwd, environment, options.message);

	// `project` is the slug; refuse a manifest whose other ids name another project.
	await verifyCloudLink(client, auth.session, cloud);

	const environments = await client.listEnvironments(auth.authorization, auth.orgIdHeader);
	const target = environments.find((e) => e.name === environment);
	if (!target) {
		throw environmentNotFound(environment, environments);
	}
	await confirmProtected(target, options);

	try {
		const result = await client.publish(auth.authorization, auth.orgIdHeader, project, body);
		return { ...result, credential: auth.mode };
	} catch (err) {
		throw explainPublishError(err, project, environment, environments);
	}
}

/**
 * Publishes with `POLI_PAGE_API_KEY`: only a service key may, into its own
 * environment, the one its `pp_{environment}_…` text names (K1). `GET /v1/me`
 * tells a service key from a standard one, since both share that format. The
 * key carries the organization, so no org header and no environment list;
 * the slug would resolve in the key's organization, so a key of another
 * organization than the linked one is refused. Nothing prompts, and the API
 * applies the protected-environment rule.
 */
async function publishWithApiKey(
	cwd: string,
	environment: string,
	options: PublishOptions,
	client: ApiClient,
	key: Extract<AuthContext, { mode: 'api-key' }>,
	project: string,
	cloud: CloudBlock
): Promise<PublishResult> {
	const { authorization } = key;

	const body = await buildPublishBody(cwd, environment, options.message);

	const { auth, org } = await client.getMe(authorization);
	if (auth.keyType !== 'service') {
		throw new PublishNotAuthorizedError(
			key.sessionIgnored
				? `Standard API keys can only render. Use a service key. ${SESSION_IGNORED_HINT}`
				: 'Standard API keys can only render. Use a service key or `poli login`.'
		);
	}
	if (cloud.orgId !== undefined && org?.id !== cloud.orgId) {
		const keyOrg = org
			? `organization "${org.name}" (${org.slug}, ${org.id})`
			: 'no known organization';
		throw new UsageError(
			`This API key belongs to ${keyOrg}, but this folder is linked to organization "${cloud.orgSlug}" (${cloud.orgId}). Use a key of "${cloud.orgSlug}", or run \`poli unlink\`, then \`poli link\`.`
		);
	}
	if (key.environment !== environment) {
		throw new UsageError(
			`This service key publishes to "${key.environment}" only, not "${environment}". Run \`poli publish --env ${key.environment}\`, or use a key for "${environment}".${key.sessionIgnored ? ` ${SESSION_IGNORED_HINT}` : ''}`
		);
	}

	try {
		return await client.publish(authorization, undefined, project, body);
	} catch (err) {
		if (err instanceof EnvironmentProtectedError) {
			throw new EnvironmentProtectedError(
				`Environment "${environment}" is protected: this service key needs the \`admin\` role to publish to it.`
			);
		}
		throw explainPublishError(err, project, environment, []);
	}
}

/** The first 12 hex digits of a `sha256:<64 hex>` bundle hash. */
export function shortBundleHash(bundleHash: string): string {
	return bundleHash.replace(/^sha256:/, '').slice(0, 12);
}

function confirmProtectedPublish(environment: string): Promise<boolean> {
	return confirmPrompt({
		message: `"${environment}" is a protected environment. Publish to it?`,
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
					confirmFn: interactive ? confirmProtectedPublish : undefined,
				});

				if (shouldEmitJson(opts)) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}
				console.log(chalk.green(`✓ Published ${result.project} to ${result.environment}`));
				console.log(
					`  ${chalk.dim('Bundle:')}  ${shortBundleHash(result.bundleHash)} (${result.fileCount} files)`
				);
				console.log(`  ${chalk.dim('Log id:')}  ${result.logId}`);
				console.log(
					`  ${chalk.dim('Auth:')}    ${result.credential === 'api-key' ? 'POLI_PAGE_API_KEY' : 'session (poli login)'}`
				);
			} catch (err) {
				console.error(chalk.red(err instanceof Error ? err.message : 'Publish failed'));
				process.exitCode = errorToExitCode(err);
			}
		});
}
