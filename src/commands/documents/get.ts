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
		.description('Fetch a document descriptor (same JSON shape as `poli render`)')
		.action(async (id: string) => {
			const { default: chalk } = await import('chalk');
			try {
				const doc = await executeDocumentsGet(id);

				// JSON descriptor on stdout — same contract as `poli render`.
				// Pipelines can `jq` it or pipe into a downstream step.
				console.log(JSON.stringify(doc, null, 2));

				// Human-friendly summary on stderr — only when the user is at
				// an interactive terminal. Scripts piping the output don't see
				// it (and don't have to filter it).
				if (process.stderr.isTTY) {
					printDescriptor(doc, chalk);
				}
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
	// `version: null` from the API means "draft" (api-spec §11.3).
	const versionLabel = doc.version ? `v${doc.version}` : 'draft';
	const orientationLabel = doc.orientation ?? '';

	console.error(chalk.green(`✓ Document ${chalk.bold(doc.documentId)}`));
	console.error(`  Template:    ${tplLabel} ${versionLabel}`);
	console.error(`  Environment: ${doc.environment}`);
	console.error(`  Format:      ${doc.format}${orientationLabel ? ' ' + orientationLabel : ''}`);
	console.error(`  Pages:       ${doc.pageCount}`);
	console.error(`  Size:        ${formatBytes(doc.sizeBytes)}`);
	console.error(`  Created:     ${created}`);
	console.error(`  Expires:     ${expires}`);
	console.error('');
	console.error(`  PDF URL: ${chalk.cyan(doc.presignedPdfUrl)}`);

	const meta = doc.metadata ?? {};
	const keys = Object.keys(meta);
	if (keys.length > 0) {
		console.error('');
		console.error('  Metadata:');
		for (const key of keys) {
			console.error(`    ${key}: ${JSON.stringify(meta[key])}`);
		}
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
