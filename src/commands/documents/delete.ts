import { Command } from 'commander';
import { resolveAuth } from '../../auth.js';
import { readManifest } from '../../manifest.js';
import { createApiClient, type ApiClient } from '../../api-client.js';

export interface DocumentsDeleteOptions {
	cwd?: string;
	homeDir?: string;
	apiClient?: ApiClient;
	yes?: boolean;
	confirmFn?: (info: { id: string }) => Promise<boolean>;
}

export async function executeDocumentsDelete(
	id: string,
	options: DocumentsDeleteOptions = {}
): Promise<void> {
	const cwd = options.cwd ?? process.cwd();

	let manifestOrgId: string | undefined;
	try {
		const manifest = await readManifest(cwd);
		manifestOrgId = manifest.cloud?.orgId;
	} catch {
		// Not in a project — leave undefined.
	}

	let auth;
	try {
		auth = await resolveAuth({ manifestOrgId, homeDir: options.homeDir });
	} catch (err) {
		if (err instanceof Error && /isn't linked/i.test(err.message)) {
			throw new Error(
				'Run this command inside a linked project, or set POLI_PAGE_API_KEY for api-key mode.'
			);
		}
		throw err;
	}

	if (!options.yes && options.confirmFn) {
		const ok = await options.confirmFn({ id });
		if (!ok) {
			throw new Error('Delete cancelled.');
		}
	}

	const client = options.apiClient ?? createApiClient();
	await client.deleteDocument(auth.authorization, auth.orgIdHeader, id);
}

export function registerDocumentsDeleteCommand(documents: Command): void {
	documents
		.command('delete <id>')
		.description('Soft-delete a document (idempotent: 204 if already deleted)')
		.option('-y, --yes', 'Skip the confirmation prompt')
		.action(async (id: string, opts: { yes?: boolean }) => {
			const { default: chalk } = await import('chalk');
			try {
				await executeDocumentsDelete(id, {
					yes: opts.yes,
					confirmFn: async ({ id: docId }) => {
						const { confirm } = await import('@inquirer/prompts');
						return confirm({
							message: `Delete document ${docId}? The PDF will be permanently removed (metadata retained for audit).`,
							default: false,
						});
					},
				});
				console.log(chalk.green(`✓ Document ${id} deleted`));
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'documents delete failed';
				console.error(chalk.red(msg));
				process.exitCode = 1;
			}
		});
}
