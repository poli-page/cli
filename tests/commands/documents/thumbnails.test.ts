import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDocumentsThumbnails } from '../../../src/commands/documents/thumbnails.js';
import {
	ThumbnailsNotAvailableError,
	DocumentNotFoundError,
	type ApiClient,
	type ThumbnailResult as ApiThumbnailResult,
} from '../../../src/api-client.js';

const TINY_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
	'Nl7BcQAAAABJRU5ErkJggg==';

function makeStubClient(overrides: Partial<ApiClient> = {}): ApiClient {
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

function fakeThumb(page: number, contentType = 'image/png'): ApiThumbnailResult {
	return {
		page,
		width: 400,
		height: 566,
		contentType,
		data: TINY_PNG_BASE64,
	};
}

describe('executeDocumentsThumbnails', () => {
	let tempDir: string;
	let fakeHome: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-docs-thumb-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-docs-thumb-home-'));
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

	it('writes PNG files to ./output/thumbnails/<id>/page-N.png by default', async () => {
		const client = makeStubClient({
			documentThumbnails: async () => [fakeThumb(1), fakeThumb(2)],
		});

		const results = await executeDocumentsThumbnails('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
		});

		expect(results).toHaveLength(2);
		expect(results[0].path).toBe(
			join(tempDir, 'output', 'thumbnails', 'doc_abc', 'page-1.png')
		);
		expect(results[1].path).toBe(
			join(tempDir, 'output', 'thumbnails', 'doc_abc', 'page-2.png')
		);
		const s = await stat(results[0].path);
		expect(s.isFile()).toBe(true);
		expect(s.size).toBeGreaterThan(0);
	});

	it('writes JPEG when format=jpeg and uses .jpeg extension', async () => {
		const client = makeStubClient({
			documentThumbnails: async () => [fakeThumb(1, 'image/jpeg')],
		});

		const results = await executeDocumentsThumbnails('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
			format: 'jpeg',
		});

		expect(results[0].path).toMatch(/page-1\.jpeg$/);
	});

	it('forwards width / quality / pages to the API', async () => {
		let captured: Record<string, unknown> = {};
		const client = makeStubClient({
			documentThumbnails: async (_a, _o, _id, opts) => {
				captured = opts as unknown as Record<string, unknown>;
				return [fakeThumb(1), fakeThumb(3)];
			},
		});

		await executeDocumentsThumbnails('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
			width: 800,
			quality: 90,
			format: 'jpeg',
			pages: [1, 3],
		});

		expect(captured).toEqual({
			width: 800,
			quality: 90,
			format: 'jpeg',
			pages: [1, 3],
		});
	});

	it('writes to custom output directory via -o', async () => {
		const customDir = join(tempDir, 'out-thumbs');
		const client = makeStubClient({
			documentThumbnails: async () => [fakeThumb(1)],
		});

		const results = await executeDocumentsThumbnails('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
			output: customDir,
		});

		expect(results[0].path).toBe(join(customDir, 'page-1.png'));
	});

	it('propagates ThumbnailsNotAvailableError (free tier)', async () => {
		const client = makeStubClient({
			documentThumbnails: async () => {
				throw new ThumbnailsNotAvailableError(
					'Thumbnails require a paid plan.'
				);
			},
		});

		await expect(
			executeDocumentsThumbnails('doc_abc', {
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: client,
			})
		).rejects.toBeInstanceOf(ThumbnailsNotAvailableError);
	});

	it('propagates DocumentNotFoundError', async () => {
		const client = makeStubClient({
			documentThumbnails: async () => {
				throw new DocumentNotFoundError('not found');
			},
		});

		await expect(
			executeDocumentsThumbnails('doc_missing', {
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: client,
			})
		).rejects.toBeInstanceOf(DocumentNotFoundError);
	});
});
