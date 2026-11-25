import { createRequire } from 'node:module';
import { Command } from 'commander';
import { registerInitCommand } from './commands/init.js';
import { registerNewCommand } from './commands/new.js';
import { registerRenderCommand } from './commands/render.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerLinkCommands } from './commands/link.js';
import { registerPublishCommand } from './commands/publish.js';
import { registerEnvCommands } from './commands/env.js';
import { registerDocumentsCommands } from './commands/documents/index.js';
import { registerWatchCommand } from './commands/watch.js';
import { registerDevCommand } from './commands/dev.js';
import { readCredentials } from './credentials.js';
import { readManifest } from './manifest.js';
import { apiOrigin, DEFAULT_API_URL } from './api-origin.js';
import { ExitCode } from './exit-codes.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

export function createProgram() {
	const program = new Command();

	program
		.name('poli')
		.description('Poli Page CLI — scaffold, generate, and manage PDF templates')
		.version(version, '-v, --version')
		.option('--api-url <url>', 'API base URL (default: https://api.poli.page)')
		.option(
			'--allow-insecure-api',
			'Allow a local API URL (localhost, 127.0.0.1); same as POLI_ALLOW_INSECURE_API=1'
		);

	// Resolve API URL via cascade:
	//   --api-url flag → POLI_API_URL env → poli-page.json cloud.apiUrl (only
	//   when it equals the stored or default URL) → ~/.polipage/credentials
	//   apiUrl → prod default. Credentials go there: an untrusted URL exits 2
	//   before any command runs.
	program.hook('preAction', async (thisCommand) => {
		const opts = thisCommand.optsWithGlobals();
		if (opts.allowInsecureApi) process.env.POLI_ALLOW_INSECURE_API = '1';
		if (opts.apiUrl) {
			process.env.POLI_API_URL = opts.apiUrl;
		} else if (!process.env.POLI_API_URL) {
			const apiUrl = await storedApiUrl();
			if (apiUrl) process.env.POLI_API_URL = apiUrl;
		}
		try {
			apiOrigin();
		} catch (err) {
			thisCommand.error(err instanceof Error ? err.message : String(err), {
				exitCode: ExitCode.INVALID_USAGE,
				code: 'poli.untrustedApiUrl',
			});
		}
	});

	registerInitCommand(program);
	registerNewCommand(program);
	registerRenderCommand(program);
	registerAuthCommands(program);
	registerLinkCommands(program);
	registerPublishCommand(program);
	registerEnvCommands(program);
	registerDocumentsCommands(program);
	registerWatchCommand(program);
	registerDevCommand(program);

	return program;
}

/**
 * The URL from the credentials file, or the manifest's `cloud.apiUrl` when it
 * names that URL or the default: a cloned folder must not pick the host the
 * CLI sends the session or the API key to.
 */
async function storedApiUrl(): Promise<string | undefined> {
	const credentials = await readCredentials();
	let manifestUrl: string | undefined;
	try {
		manifestUrl = (await readManifest(process.cwd())).cloud?.apiUrl;
	} catch {
		// Not in a project directory — that's fine
	}
	if (manifestUrl === undefined) return credentials?.apiUrl;
	if (manifestUrl === DEFAULT_API_URL || manifestUrl === credentials?.apiUrl) return manifestUrl;
	console.error(
		`Ignoring cloud.apiUrl "${manifestUrl}" in poli-page.json: pass --api-url or set POLI_API_URL to use another API.`
	);
	return credentials?.apiUrl;
}
