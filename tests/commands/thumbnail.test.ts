import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../../src/commands/init.js';
import { executeNew } from '../../src/commands/new.js';
import { executeThumbnail } from '../../src/commands/thumbnail.js';
import { writeCredentials } from '../../src/credentials.js';
import { writeManifest, readManifest } from '../../src/manifest.js';
import type { ApiClient, ThumbnailResult as ApiThumbnailResult } from '../../src/api-client.js';

// A minimal 1×1 transparent PNG as base64
const TINY_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
	'Nl7BcQAAAABJRU5ErkJggg==';

function createMockThumbnails(pages: number[] = [1]): ApiThumbnailResult[] {
	return pages.map((page) => ({
		page,
		width: 400,
		height: 566,
		contentType: 'image/png',
		data: TINY_PNG_BASE64,
	}));
}

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
	return {
		signIn: async () => ({
			user: { id: 'user_1', name: 'Test', email: 'test@test.com' },
			session: 'mock-session',
		}),
		signUp: async () => ({
			user: { id: 'user_1', name: 'Test', email: 'test@test.com' },
			session: 'mock-session',
		}),
		getOrganizations: async () => [{ id: 'org_1', name: 'Acme', slug: 'acme' }],
		listProjects: async () => [],
		createProject: async () => ({ id: 'proj_1' }),
		createApiKey: async () => ({
			key: 'pp_test_mock',
			info: { id: 'key_1', name: 'CLI (test)', environment: 'test' },
		}),
		renderPdf: async () => Buffer.from('%PDF'),
		renderThumbnails: async () => createMockThumbnails(),
		deviceRequest: async () => ({
			deviceCode: 'dc',
			userCode: 'uc',
			verificationUrl: 'http://localhost',
			expiresIn: 300,
			interval: 5,
		}),
		devicePoll: async () => ({ status: 'authorization_pending' as const }),
		updateProject: async () => {},
		publishVersion: async () => ({
			id: 'v_1',
			version: '1.0.0',
			major: 1,
			minor: 0,
			patch: 0,
			createdAt: new Date().toISOString(),
		}),
		listVersions: async () => [],
		downloadVersion: async () => ({
			manifest: {},
			templates: [],
		}),
		...overrides,
	};
}

describe('poli thumbnail', () => {
	let tempDir: string;
	let projectDir: string;
	let fakeHome: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-thumb-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-home-'));
		projectDir = await executeInit('test-project', { cwd: tempDir });
		await executeNew('invoice', { cwd: projectDir });

		// Link project
		const manifest = await readManifest(projectDir);
		manifest.cloud = { orgSlug: 'acme', projectId: 'proj_1' };
		await writeManifest(projectDir, manifest);

		// Set up credentials
		await writeCredentials(
			{
				session: 'mock-session',
				user: { id: 'user_1', name: 'Test', email: 'test@test.com' },
				orgs: { acme: { testKey: 'pp_test_abc' } },
			},
			fakeHome
		);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	// --- Basic functionality ---

	it('should generate a PNG thumbnail of page 1 by default', async () => {
		const results = await executeThumbnail('invoice', {
			cwd: projectDir,
			width: 400,
			apiClient: createMockApiClient(),
			homeDir: fakeHome,
		});

		expect(results).toHaveLength(1);
		expect(results[0].page).toBe(1);
		expect(results[0].path).toContain('invoice-400px-a4-portrait-page-1.png');

		const stats = await stat(results[0].path);
		expect(stats.isFile()).toBe(true);
		expect(stats.size).toBeGreaterThan(0);
	});

	it('should generate all pages with --all', async () => {
		const client = createMockApiClient({
			renderThumbnails: async () => createMockThumbnails([1, 2, 3]),
		});

		const results = await executeThumbnail('invoice', {
			cwd: projectDir,
			width: 400,
			all: true,
			apiClient: client,
			homeDir: fakeHome,
		});

		expect(results).toHaveLength(3);
		for (const r of results) {
			const stats = await stat(r.path);
			expect(stats.isFile()).toBe(true);
		}
	});

	it('should generate a specific page with --page', async () => {
		const client = createMockApiClient({
			renderThumbnails: async () => createMockThumbnails([3]),
		});

		const results = await executeThumbnail('invoice', {
			cwd: projectDir,
			width: 400,
			page: 3,
			apiClient: client,
			homeDir: fakeHome,
		});

		expect(results).toHaveLength(1);
		expect(results[0].page).toBe(3);
	});

	// --- Format options ---

	it('should generate JPEG when format is jpg', async () => {
		const JPEG_BASE64 = '/9j/4AAQSkZJRg=='; // Tiny JPEG stub
		const client = createMockApiClient({
			renderThumbnails: async () => [
				{ page: 1, width: 400, height: 566, contentType: 'image/jpeg', data: JPEG_BASE64 },
			],
		});

		const results = await executeThumbnail('invoice', {
			cwd: projectDir,
			width: 400,
			format: 'jpg',
			apiClient: client,
			homeDir: fakeHome,
		});

		expect(results[0].path).toMatch(/\.jpg$/);
	});

	it('should generate PNG by default', async () => {
		const results = await executeThumbnail('invoice', {
			cwd: projectDir,
			width: 400,
			apiClient: createMockApiClient(),
			homeDir: fakeHome,
		});

		expect(results[0].path).toMatch(/\.png$/);
	});

	// --- Output options ---

	it('should write to custom destination folder', async () => {
		const destDir = join(tempDir, 'custom-thumbs');
		const results = await executeThumbnail('invoice', {
			cwd: projectDir,
			width: 400,
			destinationFolder: destDir,
			apiClient: createMockApiClient(),
			homeDir: fakeHome,
		});

		expect(results[0].path).toContain('custom-thumbs');
		const stats = await stat(results[0].path);
		expect(stats.isFile()).toBe(true);
	});

	it('should use custom name pattern', async () => {
		const results = await executeThumbnail('invoice', {
			cwd: projectDir,
			width: 400,
			name: 'my-preview',
			apiClient: createMockApiClient(),
			homeDir: fakeHome,
		});

		expect(results[0].path).toContain('my-preview-400px-a4-portrait-page-1.png');
	});

	it('should use custom data via --data option', async () => {
		const dataPath = join(tempDir, 'custom-data.json');
		await writeFile(dataPath, JSON.stringify({ title: 'Custom Title' }), 'utf-8');

		let sentPayload: Record<string, unknown> = {};
		const client = createMockApiClient({
			renderThumbnails: async (_key, payload) => {
				sentPayload = payload;
				return createMockThumbnails();
			},
		});

		await executeThumbnail('invoice', {
			cwd: projectDir,
			width: 400,
			data: dataPath,
			apiClient: client,
			homeDir: fakeHome,
		});

		expect(sentPayload.data).toEqual({ title: 'Custom Title' });
	});

	// --- API payload ---

	it('should send thumbnail options to the API', async () => {
		let sentPayload: Record<string, unknown> = {};
		const client = createMockApiClient({
			renderThumbnails: async (_key, payload) => {
				sentPayload = payload;
				return createMockThumbnails();
			},
		});

		await executeThumbnail('invoice', {
			cwd: projectDir,
			width: 800,
			quality: 90,
			format: 'jpg',
			page: 2,
			apiClient: client,
			homeDir: fakeHome,
		});

		expect(sentPayload.thumbnails).toEqual({
			width: 800,
			quality: 90,
			format: 'jpeg',
			pages: [2],
		});
	});

	// --- Error handling ---

	it('should throw if template does not exist', async () => {
		await expect(
			executeThumbnail('nonexistent', {
				cwd: projectDir,
				width: 400,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			})
		).rejects.toThrow(/not found/);
	});

	it('should throw if not in a Poli Page project', async () => {
		await expect(
			executeThumbnail('invoice', {
				cwd: tempDir + '/nonexistent',
				width: 400,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			})
		).rejects.toThrow(/poli-page\.json/);
	});

	it('should throw if project is not linked', async () => {
		const manifest = await readManifest(projectDir);
		delete manifest.cloud;
		await writeManifest(projectDir, manifest);

		await expect(
			executeThumbnail('invoice', {
				cwd: projectDir,
				width: 400,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			})
		).rejects.toThrow(/not linked/);
	});

	it('should throw if not logged in', async () => {
		const emptyHome = await mkdtemp(join(tmpdir(), 'poli-nologin-'));
		await expect(
			executeThumbnail('invoice', {
				cwd: projectDir,
				width: 400,
				apiClient: createMockApiClient(),
				homeDir: emptyHome,
			})
		).rejects.toThrow(/Not logged in/);
		await rm(emptyHome, { recursive: true, force: true });
	});
});
