import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDocumentsGet, printDescriptor } from '../../../src/commands/documents/get.js';
import { writeCredentials } from '../../../src/credentials.js';
import {
	DocumentNotFoundError,
	DocumentGoneError,
	type DocumentDescriptor,
} from '../../../src/api-client.js';
import { MANIFEST_FILENAME } from '../../../src/constants.js';
import { createFakeApiClient } from '../../helpers/fake-api-client.js';
import { testApiKey } from '../../helpers/api-key.js';

const fakeDoc: DocumentDescriptor = {
	documentId: 'doc_abc',
	organizationId: '0e89d99e-1516-4b48-baa1-f49e660ad1c1',
	projectId: '8274f64d-4ea2-4f96-b596-5727a7b17268',
	projectSlug: 'invoices',
	templateId: 'tpl_1',
	templateSlug: 'invoice',
	environment: 'production',
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

	it('reports an invalid poli-page.json instead of ignoring it', async () => {
		await writeFile(join(tempDir, 'poli-page.json'), JSON.stringify({ project: { name: 'p' }, cloud: { orgSlug: 'acme', orgId: 'org_1' } }), 'utf-8');
		await expect(executeDocumentsGet('doc_abc', { cwd: tempDir, homeDir: fakeHome, apiClient: createFakeApiClient({}) })).rejects.toThrow('Invalid poli-page.json — cloud.orgId: must be a UUID');
	});

	it('returns the descriptor when authenticated via api-key (no manifest)', async () => {
		process.env.POLI_PAGE_API_KEY = testApiKey('live');

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
			authorization: `Bearer ${testApiKey('live')}`,
			orgIdHeader: undefined,
			id: 'doc_abc',
		});
	});

	it('returns the descriptor in session mode with X-Poli-Org-Id from manifest', async () => {
		await writeFile(
			join(tempDir, MANIFEST_FILENAME),
			JSON.stringify({
				project: { name: 'demo' },
				cloud: {
					orgSlug: 'acme',
					orgId: '0e89d99e-1516-4b48-baa1-f49e660ad1c1',
					projectSlug: 'invoices',
					projectId: '8274f64d-4ea2-4f96-b596-5727a7b17268',
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
			orgIdHeader: '0e89d99e-1516-4b48-baa1-f49e660ad1c1',
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
		process.env.POLI_PAGE_API_KEY = testApiKey('test');
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
		process.env.POLI_PAGE_API_KEY = testApiKey('test');
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

describe('printDescriptor', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('prints the environment and no version', () => {
		const lines: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
			lines.push(String(line ?? ''));
		});
		const plain = (s: string): string => s;
		const chalk = {
			green: plain,
			cyan: plain,
			yellow: plain,
			red: plain,
			gray: plain,
			bold: plain,
			dim: plain,
		};

		printDescriptor(fakeDoc, chalk);

		expect(lines).toContain('  Template:    invoice');
		expect(lines).toContain('  Environment: production');
		expect(lines.join('\n')).not.toMatch(/version|draft|\bv\d/i);
	});
});
