import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDocumentsDelete } from '../../../src/commands/documents/delete.js';
import { writeCredentials } from '../../../src/credentials.js';
import {
	DocumentNotFoundError,
	type ApiClient,
} from '../../../src/api-client.js';
import { MANIFEST_FILENAME } from '../../../src/constants.js';

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
		render: async () => { throw new Error('not implemented in stub'); },
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
		downloadVersion: async () => ({ manifest: {}, templates: [] }),
		getDocument: async () => {
			throw new Error('not implemented in stub');
		},
		deleteDocument: async () => {},
		documentThumbnails: async () => [],
		documentPreview: async () => ({ html: '', pageCount: 0 }),
		...overrides,
	};
}

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

	it('calls deleteDocument when --yes is set (skip prompt)', async () => {
		process.env.POLI_PAGE_API_KEY = 'pp_live_x';
		const deleteSpy = vi.fn().mockResolvedValue(undefined);
		const client = makeStubClient({ deleteDocument: deleteSpy });

		await executeDocumentsDelete('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
			yes: true,
		});

		expect(deleteSpy).toHaveBeenCalledWith('Bearer pp_live_x', undefined, 'doc_abc');
	});

	it('asks confirmFn when --yes is not set, and aborts if rejected', async () => {
		process.env.POLI_PAGE_API_KEY = 'pp_live_x';
		const deleteSpy = vi.fn().mockResolvedValue(undefined);
		const client = makeStubClient({ deleteDocument: deleteSpy });
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
		process.env.POLI_PAGE_API_KEY = 'pp_live_x';
		const deleteSpy = vi.fn().mockResolvedValue(undefined);
		const client = makeStubClient({ deleteDocument: deleteSpy });

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
			orgIdHeader: 'org_1',
		});
	});

	it('propagates DocumentNotFoundError', async () => {
		process.env.POLI_PAGE_API_KEY = 'pp_live_x';
		const client = makeStubClient({
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
