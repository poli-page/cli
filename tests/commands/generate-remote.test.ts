import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../../src/commands/init.js';
import { executeNew } from '../../src/commands/new.js';
import { executeRender } from '../../src/commands/generate.js';
import { writeCredentials } from '../../src/credentials.js';
import { writeManifest, readManifest } from '../../src/manifest.js';
import type { ApiClient } from '../../src/api-client.js';

const FAKE_PDF = Buffer.from('%PDF-1.4 fake pdf content');

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
	return {
		signIn: async () => ({
			user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
			session: 'mock-session',
		}),
		signUp: async () => ({
			user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
			session: 'mock-session',
		}),
		getOrganizations: async () => [
			{ id: 'org_1', name: 'Acme Corp', slug: 'acme-corp' },
		],
		listProjects: async () => [],
		createProject: async () => ({ id: 'proj_1' }),
		createApiKey: async () => ({
			key: 'pp_test_mock',
			info: { id: 'key_1', name: 'CLI (test)', environment: 'test' },
		}),
		renderPdf: async () => FAKE_PDF,
		renderThumbnails: async () => [],
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

describe('poli render --remote', () => {
	let tempDir: string;
	let projectDir: string;
	let fakeHome: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-remote-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-home-'));
		projectDir = await executeInit('test-project', { cwd: tempDir });
		await executeNew('invoice', { cwd: projectDir });

		// Set up linked project
		const manifest = await readManifest(projectDir);
		manifest.cloud = { orgSlug: 'acme-corp', projectId: 'proj_1' };
		await writeManifest(projectDir, manifest);

		// Set up credentials with API keys
		await writeCredentials(
			{
				session: 'mock-session',
				user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
				orgs: {
					'acme-corp': {
						testKey: 'pp_test_abc123',
						liveKey: 'pp_live_xyz789',
					},
				},
			},
			fakeHome
		);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	it('should generate a PDF via the API and save it', async () => {
		const outputPath = await executeRender('invoice', {
			cwd: projectDir,
			apiClient: createMockApiClient(),
			homeDir: fakeHome,
		});

		expect(outputPath).toContain('output/invoice.pdf');
		const content = await readFile(outputPath);
		expect(content).toEqual(FAKE_PDF);
	});

	it('should use test key by default', async () => {
		let usedKey = '';
		const client = createMockApiClient({
			renderPdf: async (apiKey) => {
				usedKey = apiKey;
				return FAKE_PDF;
			},
		});

		await executeRender('invoice', {
			cwd: projectDir,
			apiClient: client,
			homeDir: fakeHome,
		});

		expect(usedKey).toBe('pp_test_abc123');
	});

	it('should use live key when --live is set', async () => {
		let usedKey = '';
		const client = createMockApiClient({
			renderPdf: async (apiKey) => {
				usedKey = apiKey;
				return FAKE_PDF;
			},
		});

		await executeRender('invoice', {
			cwd: projectDir,
			apiClient: client,
			homeDir: fakeHome,
			live: true,
		});

		expect(usedKey).toBe('pp_live_xyz789');
	});

	it('should throw if project is not linked', async () => {
		const manifest = await readManifest(projectDir);
		delete manifest.cloud;
		await writeManifest(projectDir, manifest);

		await expect(
			executeRender('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			})
		).rejects.toThrow(/not linked/);
	});

	it('should throw if not logged in', async () => {
		const emptyHome = await mkdtemp(join(tmpdir(), 'poli-nologin-'));
		await expect(
			executeRender('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient(),
				homeDir: emptyHome,
			})
		).rejects.toThrow(/Not logged in/);
		await rm(emptyHome, { recursive: true, force: true });
	});

	it('should send template HTML and mock data to the API', async () => {
		let sentPayload: Record<string, unknown> = {};
		const client = createMockApiClient({
			renderPdf: async (_key, payload) => {
				sentPayload = payload;
				return FAKE_PDF;
			},
		});

		await executeRender('invoice', {
			cwd: projectDir,
			apiClient: client,
			homeDir: fakeHome,
		});

		expect(sentPayload).toHaveProperty('template');
		expect(sentPayload).toHaveProperty('data');
		expect(sentPayload).toHaveProperty('format');
		expect(sentPayload).toHaveProperty('orientation');
	});

	it('should write to custom output path', async () => {
		const customPath = join(tempDir, 'custom.pdf');
		const outputPath = await executeRender('invoice', {
			cwd: projectDir,
			apiClient: createMockApiClient(),
			homeDir: fakeHome,
			output: customPath,
		});

		expect(outputPath).toBe(customPath);
		const content = await readFile(outputPath);
		expect(content).toEqual(FAKE_PDF);
	});
});
