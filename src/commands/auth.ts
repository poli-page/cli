import { Command } from 'commander';
import {
	writeCredentials,
	clearCredentials,
	readCredentials,
	sessionFor,
	type StoredCredentials,
	type UserInfo,
} from '../credentials.js';
import { readCloudLink } from '../manifest.js';
import { resolveAuth } from '../auth.js';
import { createApiClient, type ApiClient, type MeResponse } from '../api-client.js';
import { apiOrigin, assertTrustedApiOrigin, DEFAULT_API_URL, assertVerificationUrl, getLoginApiUrl } from '../api-origin.js';
import { errorToExitCode, ExitCode, UsageError } from '../exit-codes.js';
import { shouldEmitJson } from '../output.js';

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
	 * a friendly message — login proceeds normally, but the env var keeps
	 * precedence over the stored session while it is set.
	 */
	envApiKey?: string;
	onEnvVarInfo?: (message: string) => void;
	/**
	 * The API URL to store in credentials after a successful login, so later
	 * runs target it without `--api-url` (develop relies on this). Only one
	 * the user chose: a URL taken from a manifest must never become the
	 * default for every later command. It must be the API this login talks
	 * to (POLI_API_URL), or the stored apiUrl and origin would disagree.
	 */
	apiUrl?: string;
}

export async function executeDeviceLogin(
	options: DeviceLoginOptions = {},
): Promise<StoredCredentials> {
	const apiUrl = options.apiUrl === undefined ? undefined : assertTrustedApiOrigin(options.apiUrl);
	if (apiUrl !== undefined && apiUrl !== apiOrigin()) {
		throw new UsageError(`Cannot store ${apiUrl}: this login talks to ${apiOrigin()}.`);
	}
	const client = options.apiClient ?? createApiClient();

	// Step 0: friendly info-message when an api-key env var is set.
	// Login is not blocked, but the env var keeps precedence over the
	// stored session (resolveAuth rule).
	const envApiKey =
		options.envApiKey !== undefined ? options.envApiKey : process.env.POLI_PAGE_API_KEY;
	if (envApiKey && options.onEnvVarInfo) {
		options.onEnvVarInfo(
			'POLI_PAGE_API_KEY is set in your environment: whoami, publish, render and documents keep using it instead of your session until you unset it.'
		);
	}

	// Step 1: Request device code
	const deviceReq = await client.deviceRequest();
	const verificationUrl = assertVerificationUrl(deviceReq.verificationUrl, apiOrigin());
	options.onUserCode?.(deviceReq.userCode, verificationUrl);

	// Step 2: Open browser
	if (options.openUrl) {
		await options.openUrl(verificationUrl);
	} else {
		const open = await import('open');
		await open.default(verificationUrl);
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
				const credentials: StoredCredentials = {
					...(apiUrl ? { apiUrl } : {}),
					origin: apiOrigin(),
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

export interface LogoutOptions {
	homeDir?: string;
	apiClient?: ApiClient;
}

/** `fileError` is set when the credentials file could not be deleted and is still on disk. */
export type LogoutResult = (
	| { status: 'not-logged-in' }
	| { status: 'revoked'; origin: string }
	| { status: 'revoke-failed'; origin: string; reason: string }
) & { fileError?: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Deletes the credentials file, then revokes the session it held: the file
 * must not outlive a logout that is killed while the revoke is in flight.
 * A file that cannot be deleted still gets its session revoked.
 */
export async function executeLogout(options: LogoutOptions = {}): Promise<LogoutResult> {
	const credentials = await readCredentials(options.homeDir);
	const fileError = await clearCredentials(options.homeDir).then(
		() => undefined,
		(error: unknown) => errorMessage(error)
	);
	const kept = fileError === undefined ? {} : { fileError };
	if (!credentials?.session) return { status: 'not-logged-in', ...kept };
	// Revoked where it was issued: sending it to the API this run targets
	// would hand the token to another origin.
	const origin = credentials.origin ?? DEFAULT_API_URL;
	try {
		const client = options.apiClient ?? createApiClient(origin);
		await client.signOut(credentials.session);
		return { status: 'revoked', origin, ...kept };
	} catch (error) {
		return { status: 'revoke-failed', origin, reason: errorMessage(error), ...kept };
	}
}

export interface WhoamiOptions {
	cwd?: string;
	homeDir?: string;
	apiClient?: ApiClient;
}

export type WhoamiResult =
	| { mode: 'session'; payload: MeResponse }
	| { mode: 'api-key'; payload: MeResponse; sessionIgnored: boolean }
	| {
			mode: 'session-no-org';
			user: UserInfo;
			orgs: Array<{ id: string; slug: string; name: string }>;
	  };

export async function executeWhoami(
	options: WhoamiOptions = {}
): Promise<WhoamiResult> {
	const cwd = options.cwd ?? process.cwd();

	const manifestOrgId = (await readCloudLink(cwd))?.orgId;

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
					orgs = await client.getOrganizations(sessionFor(credentials));
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
	if (auth.mode === 'api-key') {
		return { mode: auth.mode, payload, sessionIgnored: auth.sessionIgnored === true };
	}
	return { mode: auth.mode, payload };
}

export function registerAuthCommands(program: Command) {
	program
		.command('login')
		.description('Authenticate with Poli Page')
		.action(async () => {
			const { default: chalk } = await import('chalk');
			const { default: ora } = await import('ora');

			console.log(chalk.dim(`Logging in to ${new URL(apiOrigin()).host}`));
			const spinner = ora('Opening browser for authentication…').start();

			try {
				const credentials = await executeDeviceLogin({
					apiUrl: getLoginApiUrl(),
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
		.description('Revoke the session and clear local credentials')
		.action(async () => {
			const { default: chalk } = await import('chalk');
			const result = await executeLogout();
			if (result.status === 'revoke-failed') {
				// The reason can span lines (an unreachable API, an HTML error page).
				console.error(
					chalk.yellow(
						`Warning: the session was not revoked on ${result.origin}: it stays valid until it expires.\n  ${result.reason}`
					)
				);
			}
			if (result.fileError !== undefined) {
				if (result.status === 'revoked') {
					console.log(chalk.green(`Session revoked on ${result.origin}.`));
				}
				console.error(
					chalk.red(
						`Could not remove the local credentials file (${result.fileError}). Delete it by hand.`
					)
				);
				process.exitCode = ExitCode.INVALID_LOCAL_STATE;
			} else if (result.status === 'revoke-failed') {
				console.log(chalk.green('Logged out: local credentials removed.'));
			} else if (result.status === 'revoked') {
				console.log(chalk.green(`Logged out. Session revoked on ${result.origin}.`));
			} else {
				console.log(chalk.green('Logged out.'));
			}
		});

	program
		.command('whoami')
		.description('Show current identity (session user or API key) and active org')
		.option('--json', 'Force JSON output even in a TTY')
		.action(async (opts) => {
			const { default: chalk } = await import('chalk');
			try {
				const result = await executeWhoami();
				if (shouldEmitJson(opts)) {
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

				const role =
					result.mode !== 'session-no-org' && result.payload.auth.role
						? `, role=${result.payload.auth.role}`
						: '';
				if (result.mode === 'session') {
					const email = result.payload.user?.email ?? '(unknown)';
					const orgSlug = result.payload.org?.slug ?? '(no org)';
					console.log(`${chalk.bold(email)} @ ${chalk.cyan(orgSlug)} (session${role})`);
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
						`${chalk.bold(preview)} @ ${chalk.cyan(orgSlug)} (api-key, environment=${env}${role})`
					);
					if (result.sessionIgnored) {
						console.log(
							chalk.dim(
								'  POLI_PAGE_API_KEY is set, so it is used instead of your `poli login` session.'
							)
						);
					}
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
