import { Command } from 'commander';
import {
	writeCredentials,
	clearCredentials,
	type StoredCredentials,
} from '../credentials.js';
import { readManifest } from '../manifest.js';
import { resolveAuth } from '../auth.js';
import { createApiClient, type ApiClient, type MeResponse } from '../api-client.js';

export interface DeviceLoginOptions {
	apiClient?: ApiClient;
	homeDir?: string;
	/** Open the verification URL in the browser. Defaults to dynamic import of 'open'. */
	openUrl?: (url: string) => Promise<void>;
	/** Called when the user code is available for display. */
	onUserCode?: (userCode: string, verificationUrl: string) => void;
	/** Called on each poll tick (for progress display). */
	onPollTick?: () => void;
}

export async function executeDeviceLogin(
	options: DeviceLoginOptions = {},
): Promise<StoredCredentials> {
	const client = options.apiClient ?? createApiClient();

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
				const apiUrl = process.env.POLI_API_URL;
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

export interface WhoamiResult {
	mode: 'session' | 'api-key';
	payload: MeResponse;
}

export async function executeWhoami(
	options: WhoamiOptions = {}
): Promise<WhoamiResult> {
	const cwd = options.cwd ?? process.cwd();

	let manifestOrgId: string | undefined;
	try {
		const manifest = await readManifest(cwd);
		manifestOrgId = manifest.cloud?.orgId;
	} catch {
		// Not in a Poli Page project — leave orgId undefined; resolveAuth will
		// throw a friendly error if a session is present but orgId is needed.
	}

	let auth;
	try {
		auth = await resolveAuth({ manifestOrgId, homeDir: options.homeDir });
	} catch (err) {
		if (err instanceof Error && /isn't linked/i.test(err.message)) {
			throw new Error(
				'Run `poli whoami` inside a linked project, or set POLI_PAGE_API_KEY for api-key mode.'
			);
		}
		throw err;
	}

	const client = options.apiClient ?? createApiClient();
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
				process.exitCode = 1;
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
				const { mode, payload } = await executeWhoami();
				if (opts.json) {
					console.log(JSON.stringify(payload, null, 2));
					return;
				}
				const orgSlug = payload.org?.slug ?? '(no org)';
				if (mode === 'session') {
					const email = payload.user?.email ?? '(unknown)';
					console.log(`${chalk.bold(email)} @ ${chalk.cyan(orgSlug)} (session)`);
				} else {
					const preview = payload.key?.preview ?? '(unknown)';
					const env = payload.auth.environment ?? '(?)';
					console.log(
						`${chalk.bold(preview)} @ ${chalk.cyan(orgSlug)} (api-key, environment=${env})`
					);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'whoami failed';
				if (/Not logged in/i.test(msg)) {
					console.error(chalk.yellow(msg));
					process.exitCode = 2;
				} else {
					console.error(chalk.red(msg));
					process.exitCode = 1;
				}
			}
		});
}
