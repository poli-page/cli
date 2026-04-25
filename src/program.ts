import { createRequire } from 'node:module';
import { Command } from 'commander';
import { registerInitCommand } from './commands/init.js';
import { registerNewCommand } from './commands/new.js';
import { registerRenderCommand } from './commands/generate.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerLinkCommands } from './commands/link.js';
import { registerPublishCommand } from './commands/publish.js';
import { registerVersionsCommands } from './commands/versions.js';
import { registerThumbnailCommand } from './commands/thumbnail.js';
import { readCredentials } from './credentials.js';
import { readManifest } from './manifest.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

export function createProgram() {
	const program = new Command();

	program
		.name('poli')
		.description('Poli Page CLI — scaffold, generate, and manage PDF templates')
		.version(version, '-v, --version')
		.option('--api-url <url>', 'API base URL (default: https://api.poli.page)');

	// Resolve API URL via cascade:
	//   --api-url flag → POLI_API_URL env → poli-page.json cloud.apiUrl
	//   → ~/.polipage/credentials apiUrl → prod default
	program.hook('preAction', async (thisCommand) => {
		const opts = thisCommand.optsWithGlobals();
		if (opts.apiUrl) {
			process.env.POLI_API_URL = opts.apiUrl;
			return;
		}
		if (process.env.POLI_API_URL) return;

		// Try project-level: poli-page.json cloud.apiUrl
		try {
			const manifest = await readManifest(process.cwd());
			if (manifest.cloud?.apiUrl) {
				process.env.POLI_API_URL = manifest.cloud.apiUrl;
				return;
			}
		} catch {
			// Not in a project directory — that's fine
		}

		// Try user-level: ~/.polipage/credentials apiUrl
		const credentials = await readCredentials();
		if (credentials?.apiUrl) {
			process.env.POLI_API_URL = credentials.apiUrl;
		}
	});

	registerInitCommand(program);
	registerNewCommand(program);
	registerRenderCommand(program);
	registerAuthCommands(program);
	registerLinkCommands(program);
	registerPublishCommand(program);
	registerVersionsCommands(program);
	registerThumbnailCommand(program);

	return program;
}
