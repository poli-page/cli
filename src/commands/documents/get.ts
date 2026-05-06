import { Command } from 'commander';
import { resolveAuth } from '../../auth.js';
import { readManifest } from '../../manifest.js';
import {
	createApiClient,
	type ApiClient,
	type DocumentDescriptor,
} from '../../api-client.js';
import { errorToExitCode } from '../../exit-codes.js';

export interface DocumentsGetOptions {
	cwd?: string;
	homeDir?: string;
	apiClient?: ApiClient;
}

export async function executeDocumentsGet(
	id: string,
	options: DocumentsGetOptions = {}
): Promise<DocumentDescriptor> {
	const cwd = options.cwd ?? process.cwd();

	let manifestOrgId: string | undefined;
	try {
		const manifest = await readManifest(cwd);
		manifestOrgId = manifest.cloud?.orgId;
	} catch {
		// Not in a project — leave undefined; resolveAuth handles the friendly error.
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

	const client = options.apiClient ?? createApiClient();
	return client.getDocument(auth.authorization, auth.orgIdHeader, id);
}

export function registerDocumentsGetCommand(documents: Command): void {
	documents
		.command('get <id>')
		.description('Fetch a document descriptor (metadata + presigned PDF URL)')
		.option('--json', 'Output the descriptor as JSON')
		.action(async (id: string, opts: { json?: boolean }) => {
			const { default: chalk } = await import('chalk');
			try {
				const doc = await executeDocumentsGet(id);

				if (opts.json) {
					console.log(JSON.stringify(doc, null, 2));
					return;
				}

				printDescriptor(doc, chalk);
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'documents get failed';
				console.error(chalk.red(msg));
				process.exitCode = errorToExitCode(err);
			}
		});
}

type ChalkFn = (s: string) => string;
type ChalkLike = Record<'green' | 'cyan' | 'yellow' | 'red' | 'gray' | 'bold' | 'dim', ChalkFn>;

function printDescriptor(doc: DocumentDescriptor, chalk: ChalkLike): void {
	const created = new Date(doc.createdAt).toLocaleString();
	const expires = new Date(doc.expiresAt).toLocaleString();
	const tplLabel = doc.templateSlug ?? '(unknown)';

	console.log(chalk.green(`✓ Document ${chalk.bold(doc.documentId)}`));
	console.log(`  Template:    ${tplLabel} (v${doc.version})`);
	console.log(`  Environment: ${doc.environment}`);
	console.log(`  Format:      ${doc.format} ${doc.orientation}`);
	console.log(`  Pages:       ${doc.pageCount}`);
	console.log(`  Size:        ${formatBytes(doc.sizeBytes)}`);
	console.log(`  Created:     ${created}`);
	console.log(`  Expires:     ${expires}`);
	console.log('');
	console.log(`  PDF URL: ${chalk.cyan(doc.presignedPdfUrl)}`);

	const meta = doc.metadata ?? {};
	const keys = Object.keys(meta);
	if (keys.length > 0) {
		console.log('');
		console.log('  Metadata:');
		for (const key of keys) {
			console.log(`    ${key}: ${JSON.stringify(meta[key])}`);
		}
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
