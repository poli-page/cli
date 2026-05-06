import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDocumentsGet } from '../../../src/commands/documents/get.js';
import { writeCredentials } from '../../../src/credentials.js';
import {
	DocumentNotFoundError,
	DocumentGoneError,
	type ApiClient,
	type DocumentDescriptor,
} from '../../../src/api-client.js';
import { MANIFEST_FILENAME } from '../../../src/constants.js';

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

function makeStubClient(overrides: Partial<ApiClient> = {}): ApiClient {
	return {
		signIn: async () => ({
			user: { id: 'u', name: 'n', email: 'e' },
			session: 's',
		}),
		signUp: async () => ({
			user: { id: 'u', name: 'n', email: 'e' },
			session: 's',
		}),
		deviceRequest: async () => ({
			deviceCode: 'd',
			userCode: 'u',
			verificationUrl: 'http://x',
			expiresIn: 1,
			interval: 1,
		}),
		devicePoll: async () => ({ status: 'authorization_pending' as const }),
		getOrganizations: async () => [],
		listProjects: async () => [],
		createProject: async () => ({ id: 'p' }),
		updateProject: async () => {},
		createApiKey: async () => ({
			key: 'pp_test_x',
			info: { id: 'k', name: 'n', environment: 'test' },
		}),
		renderPdf: async () => ({ pdf: Buffer.from(''), environment: null }),
		getMe: async () => {
			throw new Error('not implemented in stub');
		},
		pushVersion: async () => ({
			id: 'v',
			version: '1.0.0',
			major: 1,
			minor: 0,
			patch: 0,
			state: 'SANDBOX' as const,
			createdAt: '',
		}),
		listVersions: async () => [],
		promoteVersion: async () => ({
			id: 'v',
			version: '1.0.0',
			major: 1,
			minor: 0,
			patch: 0,
			state: 'LIVE' as const,
			createdAt: '',
		}),
		unpromoteVersion: async () => ({
			id: 'v',
			version: '1.0.0',
			major: 1,
			minor: 0,
			patch: 0,
			state: 'SANDBOX' as const,
			createdAt: '',
		}),
		unpromotePreview: async () => ({
			currentLatestLive: null,
			newLatestLiveAfterUnpromote: null,
			willHaveNoLive: true,
			recentLiveCalls: 0,
		}),
		deprecateVersion: async () => ({
			id: 'v',
			version: '1.0.0',
			major: 1,
			minor: 0,
			patch: 0,
			state: 'DEPRECATED' as const,
			createdAt: '',
		}),
		undeprecateVersion: async () => ({
			id: 'v',
			version: '1.0.0',
			major: 1,
			minor: 0,
			patch: 0,
			state: 'SANDBOX' as const,
			createdAt: '',
		}),
		downloadVersion: async () => ({
			manifest: {},
			templates: [],
		}),
		getDocument: async () => fakeDoc,
		deleteDocument: async () => {},
		documentThumbnails: async () => [],
		documentPreview: async () => ({ html: '', pageCount: 0 }),
		...overrides,
	};
}

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
		const client = makeStubClient({
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
		const client = makeStubClient({
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
				apiClient: makeStubClient(),
			})
		).rejects.toThrow(/linked project|POLI_PAGE_API_KEY/i);
	});

	it('propagates DocumentNotFoundError', async () => {
		process.env.POLI_PAGE_API_KEY = 'pp_test_x';
		const client = makeStubClient({
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
		const client = makeStubClient({
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
