import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDocumentsGet } from '../../src/commands/documents/get.js';
import { executeDocumentsDelete } from '../../src/commands/documents/delete.js';
import { executeDocumentsPreview } from '../../src/commands/documents/preview.js';
import { executeDocumentsThumbnails } from '../../src/commands/documents/thumbnails.js';
import { executeWhoami } from '../../src/commands/auth.js';
import { writeCredentials } from '../../src/credentials.js';
import { ManifestValidationError } from '../../src/manifest.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';
import { createFakeApiClient } from '../helpers/fake-api-client.js';

// These commands read poli-page.json only for cloud.orgId: a missing file
// means "not in a project", but a manifest that fails validation must be
// reported as such, not as an unlinked folder.
const commands: Array<[string, (cwd: string, homeDir: string) => Promise<unknown>]> = [
	[
		'documents get',
		(cwd, homeDir) =>
			executeDocumentsGet('doc_abc', { cwd, homeDir, apiClient: createFakeApiClient({}) }),
	],
	[
		'documents delete',
		(cwd, homeDir) =>
			executeDocumentsDelete('doc_abc', {
				cwd,
				homeDir,
				apiClient: createFakeApiClient({}),
				yes: true,
			}),
	],
	[
		'documents preview',
		(cwd, homeDir) =>
			executeDocumentsPreview('doc_abc', {
				cwd,
				homeDir,
				apiClient: createFakeApiClient({}),
				noOpen: true,
			}),
	],
	[
		'documents thumbnails',
		(cwd, homeDir) =>
			executeDocumentsThumbnails('doc_abc', {
				cwd,
				homeDir,
				apiClient: createFakeApiClient({}),
			}),
	],
	[
		'whoami',
		(cwd, homeDir) => executeWhoami({ cwd, homeDir, apiClient: createFakeApiClient({}) }),
	],
];

describe('commands that read the manifest for cloud.orgId', () => {
	let tempDir: string;
	let fakeHome: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-org-context-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-org-context-home-'));
		savedEnv = process.env.POLI_PAGE_API_KEY;
		delete process.env.POLI_PAGE_API_KEY;
		await writeCredentials(
			{
				session: 'sess-tok',
				user: { id: 'u', name: 'X', email: 'x@x.com' },
				orgs: { acme: {} },
			},
			fakeHome
		);
		await writeFile(
			join(tempDir, MANIFEST_FILENAME),
			JSON.stringify({
				project: { name: 'demo' },
				cloud: {
					orgSlug: 'acme',
					orgId: 'org_1',
					projectSlug: 'invoices',
					projectId: 'proj_1',
				},
				templates: [
					{
						name: 'Invoice_v2',
						template: 'invoice.html',
						format: 'A4',
						orientation: 'portrait',
					},
				],
			})
		);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
		if (savedEnv === undefined) {
			delete process.env.POLI_PAGE_API_KEY;
		} else {
			process.env.POLI_PAGE_API_KEY = savedEnv;
		}
	});

	it.each(commands)('%s reports an invalid manifest with its field path', async (_name, run) => {
		const error = await run(tempDir, fakeHome).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(ManifestValidationError);
		expect((error as Error).message).toContain('templates[0].name');
	});
});
