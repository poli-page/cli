import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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

describe('poli render', () => {
	let tempDir: string;
	let projectDir: string;
	let fakeHome: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-gen-'));
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

	it('should generate a PDF file in the output/ directory', async () => {
		const outputPath = await executeRender('invoice', {
			cwd: projectDir,
			apiClient: createMockApiClient(),
			homeDir: fakeHome,
		});

		expect(outputPath).toContain('output/invoice.pdf');
		const stats = await stat(outputPath);
		expect(stats.isFile()).toBe(true);
		expect(stats.size).toBeGreaterThan(0);
	});

	it('should generate a PDF to a custom output path', async () => {
		const customPath = join(tempDir, 'custom-output.pdf');
		const outputPath = await executeRender('invoice', {
			cwd: projectDir,
			output: customPath,
			apiClient: createMockApiClient(),
			homeDir: fakeHome,
		});

		expect(outputPath).toBe(customPath);
		const stats = await stat(outputPath);
		expect(stats.isFile()).toBe(true);
	});

	it('should accept custom data via --data option', async () => {
		const dataPath = join(tempDir, 'custom-data.json');
		await writeFile(
			dataPath,
			JSON.stringify({ title: 'Custom Title', company: 'Custom Corp' }),
			'utf-8'
		);

		let sentPayload: Record<string, unknown> = {};
		const client = createMockApiClient({
			renderPdf: async (_key, payload) => {
				sentPayload = payload;
				return FAKE_PDF;
			},
		});

		await executeRender('invoice', {
			cwd: projectDir,
			data: dataPath,
			apiClient: client,
			homeDir: fakeHome,
		});

		expect(sentPayload.data).toEqual({ title: 'Custom Title', company: 'Custom Corp' });
	});

	it('should throw if template does not exist', async () => {
		await expect(
			executeRender('nonexistent', {
				cwd: projectDir,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			})
		).rejects.toThrow(/not found/);
	});

	it('should throw if not in a Poli Page project', async () => {
		await expect(
			executeRender('invoice', {
				cwd: tempDir + '/nonexistent',
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			})
		).rejects.toThrow(/poli-page\.json/);
	});
});
