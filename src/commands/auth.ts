import { Command } from 'commander';
import {
	writeCredentials,
	clearCredentials,
	readCredentials,
	type StoredCredentials,
	type UserInfo,
} from '../credentials.js';
import { readManifest } from '../manifest.js';
import { resolveAuth } from '../auth.js';
import { createApiClient, type ApiClient, type MeResponse } from '../api-client.js';
import { errorToExitCode, ExitCode } from '../exit-codes.js';

export interface DeviceLoginOptions {
	apiClient?: ApiClient;
	homeDir?: string;
	/** Open the verification URL in the browser. Defaults to dynamic import of 'open'. */
	openUrl?: (url: string) => Promise<void>;
	/** Called when the user code is available for display. */
	onUserCode?: (userCode: string, verificationUrl: string) => void;
	/** Called on each poll tick (for progress display). */
	onPollTick?: () => void;
	/**
	 * Inject the POLI_PAGE_API_KEY value (defaults to the env var). When set
	 * and the device flow is about to run, `onEnvVarInfo` is invoked with
	 * a friendly message — login proceeds normally; once it succeeds the
	 * stored session takes precedence over the env var (precedence rule).
	 */
	envApiKey?: string;
	onEnvVarInfo?: (message: string) => void;
	/**
	 * Explicit API URL to persist in credentials after a successful login.
	 * When omitted, falls back to `process.env.POLI_API_URL`. This is the
	 * value the CLI will use on subsequent runs without `--api-url` —
	 * critical for non-prod (develop) targeting, which relies on a custom
	 * URL but should not require the flag at every invocation.
	 */
	apiUrl?: string;
}

export async function executeDeviceLogin(
	options: DeviceLoginOptions = {},
): Promise<StoredCredentials> {
	const client = options.apiClient ?? createApiClient();

	// Step 0: friendly info-message when an api-key env var is set.
	// Login is not blocked — but once the session is stored, it takes
	// precedence over the env var (resolveAuth rule).
	const envApiKey =
		options.envApiKey !== undefined ? options.envApiKey : process.env.POLI_PAGE_API_KEY;
	if (envApiKey && options.onEnvVarInfo) {
		options.onEnvVarInfo(
			'POLI_PAGE_API_KEY is set in your environment. After login completes, your session will be preferred over the env var.'
		);
	}

	// Step 1: Request device code
	const deviceReq = await client.deviceRequest();
	options.onUserCode?.(deviceReq.userCode, deviceReq.verificationUrl);

	// Step 2: Open browser
	if (options.openUrl) {
		await options.openUrl(deviceReq.verificationUrl);
	} else {
		const open = await import('open');
		await open.default(deviceReq.verificationUrl);
	}

	// Step 3: Poll for confirmation
	const deadline = Date.now() + deviceReq.expiresIn * 1000;

	function abortableSleep(ms: number): { promise: Promise<void>; abort: () => void } {
		let timer: ReturnType<typeof setTimeout>;
		let resolve: () => void;
		const promise = new Promise<void>((r) => {
			resolve = r;
			timer = setTimeout(r, ms);
		});
		return { promise, abort: () => { clearTimeout(timer); resolve(); } };
	}

	let currentSleep: { abort: () => void } | null = null;
	let aborted = false;
	const onSigint = () => {
		aborted = true;
		currentSleep?.abort();
	};
	process.on('SIGINT', onSigint);

	try {
		while (Date.now() < deadline && !aborted) {
			const sleep = abortableSleep(deviceReq.interval * 1000);
			currentSleep = sleep;
			await sleep.promise;
			currentSleep = null;

			if (aborted) break;
			options.onPollTick?.();

			const result = await client.devicePoll(deviceReq.deviceCode);

			if (result.status === 'confirmed' && result.sessionToken && result.user) {
				const apiUrl = options.apiUrl ?? process.env.POLI_API_URL;
				const credentials: StoredCredentials = {
					...(apiUrl ? { apiUrl } : {}),
					session: result.sessionToken,
					user: result.user,
					orgs: {},
				};

				try {
					const orgs = await client.getOrganizations(result.sessionToken);
					for (const org of orgs) {
						credentials.orgs[org.slug] = {};
					}
				} catch {
					// Orgs fetch may fail — that's ok
				}

				await writeCredentials(credentials, options.homeDir);
				return credentials;
			}

			if (result.status === 'expired') {
				throw new Error('Device authorization expired. Please try again.');
			}
		}

		if (aborted) {
			throw new Error('Login cancelled.');
		}

		throw new Error('Device authorization timed out. Please try again.');
	} finally {
		process.removeListener('SIGINT', onSigint);
	}
}

export async function executeLogout(homeDir?: string): Promise<void> {
	await clearCredentials(homeDir);
}

export interface WhoamiOptions {
	cwd?: string;
	homeDir?: string;
	apiClient?: ApiClient;
}

export type WhoamiResult =
	| { mode: 'session'; payload: MeResponse }
	| { mode: 'api-key'; payload: MeResponse }
	| {
			mode: 'session-no-org';
			user: UserInfo;
			orgs: Array<{ id: string; slug: string; name: string }>;
	  };

export async function executeWhoami(
	options: WhoamiOptions = {}
): Promise<WhoamiResult> {
	const cwd = options.cwd ?? process.cwd();

	let manifestOrgId: string | undefined;
	try {
		const manifest = await readManifest(cwd);
		manifestOrgId = manifest.cloud?.orgId;
	} catch {
		// Not in a Poli Page project — leave orgId undefined.
	}

	const client = options.apiClient ?? createApiClient();

	let auth;
	try {
		auth = await resolveAuth({ manifestOrgId, homeDir: options.homeDir });
	} catch (err) {
		// Session is present but no linked project — fall back to listing the
		// orgs the session can see. Identity check should work from anywhere.
		if (err instanceof Error && /isn't linked/i.test(err.message)) {
			const credentials = await readCredentials(options.homeDir);
			if (credentials?.session) {
				let orgs: Array<{ id: string; slug: string; name: string }>;
				try {
					orgs = await client.getOrganizations(credentials.session);
				} catch {
					// 401 / network / API issue — the session is no longer usable.
					throw new Error(
						'Not logged in. Run `poli login` or set POLI_PAGE_API_KEY.'
					);
				}
				return { mode: 'session-no-org', user: credentials.user, orgs };
			}
		}
		throw err;
	}

	const payload = await client.getMe(auth.authorization, auth.orgIdHeader);
	return { mode: auth.mode, payload };
}

export function registerAuthCommands(program: Command) {
	program
		.command('login')
		.description('Authenticate with Poli Page')
		.action(async () => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');

			const spinner = ora('Opening browser for authentication…').start();

			try {
				const credentials = await executeDeviceLogin({
					onEnvVarInfo: (msg) => {
						spinner.info(chalk.dim(msg));
						spinner.start('Opening browser for authentication…');
					},
					onUserCode: (userCode, verificationUrl) => {
						spinner.info(
							chalk.cyan(`Your code: ${chalk.bold(userCode)}`)
						);
						console.log(
							chalk.dim(`  Opening ${verificationUrl}`)
						);
						console.log(
							chalk.dim('  Complete sign-in in your browser.\n')
						);
						spinner.start('Waiting for authorization…');
					},
					onPollTick: () => {
						// Keep spinner alive
					},
				});

				const orgCount = Object.keys(credentials.orgs).length;
				spinner.succeed(
					chalk.green(
						`Logged in as ${credentials.user.name} (${credentials.user.email})` +
							(orgCount > 0 ? ` — ${orgCount} organization(s)` : '')
					)
				);
			} catch (error) {
				spinner.fail(
					chalk.red(error instanceof Error ? error.message : 'Login failed')
				);
				process.exitCode = errorToExitCode(error);
			}
		});

	program
		.command('logout')
		.description('Clear local credentials')
		.action(async () => {
			const { default: chalk } = await import('chalk');
			await executeLogout();
			console.log(chalk.green('Logged out.'));
		});

	program
		.command('whoami')
		.description('Show current identity (session user or API key) and active org')
		.option('--json', 'Output the raw /v1/me payload as JSON')
		.action(async (opts) => {
			const { default: chalk } = await import('chalk');
			try {
				const result = await executeWhoami();
				if (opts.json) {
					if (result.mode === 'session-no-org') {
						console.log(
							JSON.stringify(
								{ mode: result.mode, user: result.user, orgs: result.orgs },
								null,
								2
							)
						);
					} else {
						console.log(JSON.stringify(result.payload, null, 2));
					}
					return;
				}

				if (result.mode === 'session') {
					const email = result.payload.user?.email ?? '(unknown)';
					const orgSlug = result.payload.org?.slug ?? '(no org)';
					console.log(`${chalk.bold(email)} @ ${chalk.cyan(orgSlug)} (session)`);
				} else if (result.mode === 'session-no-org') {
					const email = result.user.email;
					const count = result.orgs.length;
					const orgList =
						count === 0
							? '(no organizations)'
							: count === 1
								? result.orgs[0].slug
								: `${count} organizations: ${result.orgs.map((o) => o.slug).join(', ')}`;
					console.log(
						`${chalk.bold(email)} (session, ${chalk.cyan(orgList)})`
					);
					if (count > 0) {
						console.log(
							chalk.dim(
								'  Run `poli link` inside a project to bind it to an organization.'
							)
						);
					}
				} else {
					const preview = result.payload.key?.preview ?? '(unknown)';
					const orgSlug = result.payload.org?.slug ?? '(no org)';
					const env = result.payload.auth.environment ?? '(?)';
					console.log(
						`${chalk.bold(preview)} @ ${chalk.cyan(orgSlug)} (api-key, environment=${env})`
					);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'whoami failed';
				if (/Not logged in/i.test(msg)) {
					console.error(chalk.yellow(msg));
					process.exitCode = ExitCode.NOT_AUTHENTICATED;
				} else {
					console.error(chalk.red(msg));
					process.exitCode = errorToExitCode(err);
				}
			}
		});
}
