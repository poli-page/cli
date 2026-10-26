import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDocumentsGet } from '../../../src/commands/documents/get.js';
import { writeCredentials } from '../../../src/credentials.js';
import {
	DocumentNotFoundError,
	DocumentGoneError,
	type DocumentDescriptor,
} from '../../../src/api-client.js';
import { MANIFEST_FILENAME } from '../../../src/constants.js';
import { createFakeApiClient } from '../../helpers/fake-api-client.js';

const fakeDoc: DocumentDescriptor = {
	documentId: 'doc_abc',
	organizationId: 'org_1',
	projectId: 'proj_1',
	projectSlug: 'invoices',
	templateId: 'tpl_1',
	templateSlug: 'invoice',
	version: '1.0.5',
	environment: 'live',
	apiKeyId: 'key_1',
	createdAt: '2026-04-15T14:32:18.000Z',
	pageCount: 2,
	sizeBytes: 18432,
	format: 'A4',
	orientation: 'portrait',
	locale: 'en',
	metadata: { chantierId: 123 },
	presignedPdfUrl: 'https://s3.example/doc_abc.pdf?sig=abc',
	expiresAt: '2026-04-15T14:47:18.000Z',
};

describe('executeDocumentsGet', () => {
	let tempDir: string;
	let fakeHome: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-docs-get-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-docs-get-home-'));
		savedEnv = process.env.POLI_PAGE_API_KEY;
		delete process.env.POLI_PAGE_API_KEY;
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

	it('returns the descriptor when authenticated via api-key (no manifest)', async () => {
		process.env.POLI_PAGE_API_KEY = 'pp_live_abc';

		let captured: { authorization?: string; orgIdHeader?: string; id?: string } = {};
		const client = createFakeApiClient({
			getDocument: async (authorization, orgIdHeader, id) => {
				captured = { authorization, orgIdHeader, id };
				return fakeDoc;
			},
		});

		const result = await executeDocumentsGet('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
		});

		expect(result).toEqual(fakeDoc);
		expect(captured).toEqual({
			authorization: 'Bearer pp_live_abc',
			orgIdHeader: undefined,
			id: 'doc_abc',
		});
	});

	it('returns the descriptor in session mode with X-Poli-Org-Id from manifest', async () => {
		await writeFile(
			join(tempDir, MANIFEST_FILENAME),
			JSON.stringify({
				project: { name: 'demo', version: '0.1.0' },
				cloud: {
					orgSlug: 'acme',
					orgId: 'org_1',
					projectSlug: 'invoices',
					projectId: 'proj_1',
				},
				templates: [],
			})
		);
		await writeCredentials(
			{
				session: 'sess-tok',
				user: { id: 'u', name: 'X', email: 'x@x.com' },
				orgs: { acme: {} },
			},
			fakeHome
		);

		let captured: { authorization?: string; orgIdHeader?: string } = {};
		const client = createFakeApiClient({
			getDocument: async (authorization, orgIdHeader) => {
				captured = { authorization, orgIdHeader };
				return fakeDoc;
			},
		});

		await executeDocumentsGet('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
		});

		expect(captured).toEqual({
			authorization: 'Bearer sess-tok',
			orgIdHeader: 'org_1',
		});
	});

	it('throws a friendly error when session is set but no project is linked', async () => {
		await writeCredentials(
			{
				session: 'sess-tok',
				user: { id: 'u', name: 'X', email: 'x@x.com' },
				orgs: {},
			},
			fakeHome
		);

		await expect(
			executeDocumentsGet('doc_abc', {
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: createFakeApiClient({}),
			})
		).rejects.toThrow(/linked project|POLI_PAGE_API_KEY/i);
	});

	it('propagates DocumentNotFoundError', async () => {
		process.env.POLI_PAGE_API_KEY = 'pp_test_x';
		const client = createFakeApiClient({
			getDocument: async () => {
				throw new DocumentNotFoundError('Document not found');
			},
		});

		await expect(
			executeDocumentsGet('doc_missing', {
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: client,
			})
		).rejects.toBeInstanceOf(DocumentNotFoundError);
	});

	it('propagates DocumentGoneError', async () => {
		process.env.POLI_PAGE_API_KEY = 'pp_test_x';
		const client = createFakeApiClient({
			getDocument: async () => {
				throw new DocumentGoneError('Document soft-deleted');
			},
		});

		await expect(
			executeDocumentsGet('doc_deleted', {
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: client,
			})
		).rejects.toBeInstanceOf(DocumentGoneError);
	});
});
