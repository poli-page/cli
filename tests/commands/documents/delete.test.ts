import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDocumentsDelete } from '../../../src/commands/documents/delete.js';
import { writeCredentials } from '../../../src/credentials.js';
import { DocumentNotFoundError } from '../../../src/api-client.js';
import { MANIFEST_FILENAME } from '../../../src/constants.js';
import { createFakeApiClient } from '../../helpers/fake-api-client.js';
import { testApiKey } from '../../helpers/api-key.js';

describe('executeDocumentsDelete', () => {
	let tempDir: string;
	let fakeHome: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-docs-del-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-docs-del-home-'));
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
		await expect(executeDocumentsDelete('doc_abc', { cwd: tempDir, homeDir: fakeHome, apiClient: createFakeApiClient({}), yes: true })).rejects.toThrow('Invalid poli-page.json — cloud.orgId: must be a UUID');
	});

	it('calls deleteDocument when --yes is set (skip prompt)', async () => {
		process.env.POLI_PAGE_API_KEY = testApiKey('live');
		const deleteSpy = vi.fn().mockResolvedValue(undefined);
		const client = createFakeApiClient({ deleteDocument: deleteSpy });

		await executeDocumentsDelete('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
			yes: true,
		});

		expect(deleteSpy).toHaveBeenCalledWith(
			`Bearer ${testApiKey('live')}`,
			undefined,
			'doc_abc'
		);
	});

	it('asks confirmFn when --yes is not set, and aborts if rejected', async () => {
		process.env.POLI_PAGE_API_KEY = testApiKey('live');
		const deleteSpy = vi.fn().mockResolvedValue(undefined);
		const client = createFakeApiClient({ deleteDocument: deleteSpy });
		const confirmFn = vi.fn().mockResolvedValue(false);

		await expect(
			executeDocumentsDelete('doc_abc', {
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: client,
				confirmFn,
			})
		).rejects.toThrow(/cancelled/i);

		expect(confirmFn).toHaveBeenCalledWith({ id: 'doc_abc' });
		expect(deleteSpy).not.toHaveBeenCalled();
	});

	it('proceeds when confirmFn approves', async () => {
		process.env.POLI_PAGE_API_KEY = testApiKey('live');
		const deleteSpy = vi.fn().mockResolvedValue(undefined);
		const client = createFakeApiClient({ deleteDocument: deleteSpy });

		await executeDocumentsDelete('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
			confirmFn: async () => true,
		});

		expect(deleteSpy).toHaveBeenCalledTimes(1);
	});

	it('uses session auth with manifest orgId', async () => {
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
			deleteDocument: async (authorization, orgIdHeader) => {
				captured = { authorization, orgIdHeader };
			},
		});

		await executeDocumentsDelete('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
			yes: true,
		});

		expect(captured).toEqual({
			authorization: 'Bearer sess-tok',
			orgIdHeader: '0e89d99e-1516-4b48-baa1-f49e660ad1c1',
		});
	});

	it('propagates DocumentNotFoundError', async () => {
		process.env.POLI_PAGE_API_KEY = testApiKey('live');
		const client = createFakeApiClient({
			deleteDocument: async () => {
				throw new DocumentNotFoundError('not found');
			},
		});

		await expect(
			executeDocumentsDelete('doc_missing', {
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: client,
				yes: true,
			})
		).rejects.toBeInstanceOf(DocumentNotFoundError);
	});
});
