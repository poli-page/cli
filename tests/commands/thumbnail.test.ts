import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeThumbnailAlias } from '../../src/commands/thumbnail.js';
import {
	type ApiClient,
	type ThumbnailResult as ApiThumbnailResult,
} from '../../src/api-client.js';

const TINY_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
	'Nl7BcQAAAABJRU5ErkJggg==';

function makeStubClient(overrides: Partial<ApiClient> = {}): ApiClient {
	const fakeThumb: ApiThumbnailResult = {
		page: 1,
		width: 400,
		height: 566,
		contentType: 'image/png',
		data: TINY_PNG_BASE64,
	};
	return {
		signIn: async () => ({ user: { id: 'u', name: 'n', email: 'e' }, session: 's' }),
		signUp: async () => ({ user: { id: 'u', name: 'n', email: 'e' }, session: 's' }),
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
		documentThumbnails: async () => [fakeThumb],
		documentPreview: async () => ({ html: '', pageCount: 0 }),
		...overrides,
	};
}

describe('executeThumbnailAlias', () => {
	let tempDir: string;
	let fakeHome: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-thumb-alias-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-thumb-alias-home-'));
		savedEnv = process.env.POLI_PAGE_API_KEY;
		process.env.POLI_PAGE_API_KEY = 'pp_live_x';
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

	it('throws a friendly error when documentId is missing', async () => {
		await expect(
			executeThumbnailAlias(undefined, {
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: makeStubClient(),
			})
		).rejects.toThrow(/documentId|poli render/i);
	});

	it('forwards to documents thumbnails when documentId is provided', async () => {
		const spy = vi.fn().mockResolvedValue([
			{
				page: 1,
				width: 400,
				height: 566,
				contentType: 'image/png',
				data: TINY_PNG_BASE64,
			},
		]);
		const client = makeStubClient({ documentThumbnails: spy });

		const results = await executeThumbnailAlias('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
			width: 400,
		});

		expect(spy).toHaveBeenCalledTimes(1);
		const callArgs = spy.mock.calls[0];
		expect(callArgs[2]).toBe('doc_abc');
		expect(callArgs[3]).toEqual({ width: 400 });
		expect(results).toHaveLength(1);
		const s = await stat(results[0].path);
		expect(s.isFile()).toBe(true);
	});
});
