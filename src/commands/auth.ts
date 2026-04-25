import { Command } from 'commander';
import {
	writeCredentials,
	clearCredentials,
	readCredentials,
	type StoredCredentials,
} from '../credentials.js';
import { createApiClient, type ApiClient } from '../api-client.js';

export interface LoginOptions {
	email: string;
	password: string;
	apiClient?: ApiClient;
	homeDir?: string;
}

export async function executeLogin(options: LoginOptions): Promise<StoredCredentials> {
	const client = options.apiClient ?? createApiClient();
	const { user, session } = await client.signIn(options.email, options.password);

	// Persist the API URL if a non-default one was used
	const apiUrl = process.env.POLI_API_URL;

	const credentials: StoredCredentials = {
		...(apiUrl ? { apiUrl } : {}),
		session,
		user,
		orgs: {},
	};

	// Fetch user's organizations and store them
	try {
		const orgs = await client.getOrganizations(session);
		for (const org of orgs) {
			credentials.orgs[org.slug] = {};
		}
	} catch {
		// Orgs fetch may fail if user has none — that's ok
	}

	await writeCredentials(credentials, options.homeDir);
	return credentials;
}

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

export async function executeWhoami(homeDir?: string): Promise<{
	user: { name: string; email: string };
	orgs: string[];
} | null> {
	const credentials = await readCredentials(homeDir);
	if (!credentials) {
		return null;
	}
	return {
		user: { name: credentials.user.name, email: credentials.user.email },
		orgs: Object.keys(credentials.orgs),
	};
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
		.description('Show current user and organizations')
		.action(async () => {
			const { default: chalk } = await import('chalk');
			const info = await executeWhoami();
			if (!info) {
				console.log(chalk.yellow('Not logged in. Run "poli login" first.'));
				return;
			}
			console.log(`${chalk.bold(info.user.name)} (${info.user.email})`);
			if (info.orgs.length > 0) {
				console.log(`Organizations: ${info.orgs.join(', ')}`);
			} else {
				console.log(chalk.dim('No organizations'));
			}
		});
}
