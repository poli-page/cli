import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../../src/commands/init.js';
import { executePublish } from '../../src/commands/publish.js';
import { writeCredentials } from '../../src/credentials.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';
import type { ApiClient } from '../../src/api-client.js';

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
	return {
		signIn: async () => ({
			user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
			session: 'mock-session-token',
		}),
		signUp: async () => ({
			user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
			session: 'mock-session-token',
		}),
		getOrganizations: async () => [
			{ id: 'org_1', name: 'Acme Corp', slug: 'acme-corp' },
		],
		listProjects: async () => [],
		createProject: async () => ({ id: 'proj_abc123' }),
		updateProject: vi.fn(async () => {}),
		createApiKey: async () => ({
			key: 'pp_test_mock123',
			info: { id: 'key_1', name: 'CLI (test)', environment: 'test' },
		}),
		renderPdf: async () => Buffer.from('fake-pdf'),
		publishVersion: vi.fn(async () => ({
			id: 'ver_1',
			version: '1.0.0',
			major: 1,
			minor: 0,
			patch: 0,
			createdAt: new Date().toISOString(),
		})),
		listVersions: async () => [],
		downloadVersion: async () => ({
			manifest: {},
			templates: [],
		}),
		...overrides,
	};
}

describe('poli publish', () => {
	let tempDir: string;
	let projectDir: string;
	let fakeHome: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-publish-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-home-'));
		projectDir = await executeInit('test-project', { cwd: tempDir });

		// Simulate logged-in user
		await writeCredentials(
			{
				session: 'mock-session',
				user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
				orgs: { 'acme-corp': { testKey: 'pp_test_abc' } },
			},
			fakeHome,
		);

		// Link project manually
		const manifestPath = join(projectDir, MANIFEST_FILENAME);
		const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
		manifest.cloud = { orgSlug: 'acme-corp', projectId: 'proj_abc123' };
		await writeFile(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	it('should sync draft then publish version', async () => {
		const client = createMockApiClient();
		const result = await executePublish({
			cwd: projectDir,
			apiClient: client,
			homeDir: fakeHome,
		});

		expect(result.version).toBe('1.0.0');
		expect(client.updateProject).toHaveBeenCalledWith(
			'mock-session',
			'org_1',
			'proj_abc123',
			expect.objectContaining({
				manifest: expect.objectContaining({
					project: expect.objectContaining({ name: 'test-project' }),
				}),
			}),
		);
		expect(client.publishVersion).toHaveBeenCalledWith(
			'mock-session',
			'org_1',
			'proj_abc123',
		);
	});

	it('should update manifest version after publish', async () => {
		const client = createMockApiClient({
			publishVersion: vi.fn(async () => ({
				id: 'ver_1',
				version: '2.1.0',
				major: 2,
				minor: 1,
				patch: 0,
				createdAt: new Date().toISOString(),
			})),
		});

		await executePublish({
			cwd: projectDir,
			apiClient: client,
			homeDir: fakeHome,
		});

		const manifest = JSON.parse(
			await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8'),
		);
		expect(manifest.project.version).toBe('2.1.0');
	});

	it('should throw if project is not linked', async () => {
		// Remove cloud config
		const manifestPath = join(projectDir, MANIFEST_FILENAME);
		const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
		delete manifest.cloud;
		await writeFile(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');

		await expect(
			executePublish({
				cwd: projectDir,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			}),
		).rejects.toThrow(/not linked/);
	});

	it('should throw if not logged in', async () => {
		const emptyHome = await mkdtemp(join(tmpdir(), 'poli-nologin-'));
		await expect(
			executePublish({
				cwd: projectDir,
				apiClient: createMockApiClient(),
				homeDir: emptyHome,
			}),
		).rejects.toThrow(/Not logged in/);
		await rm(emptyHome, { recursive: true, force: true });
	});

	it('should include font files in sync payload', async () => {
		// Add a font file
		const fontsDir = join(projectDir, 'assets', 'fonts');
		await mkdir(fontsDir, { recursive: true });
		await writeFile(join(fontsDir, 'inter-400.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));

		// Update manifest with font entry
		const manifestPath = join(projectDir, MANIFEST_FILENAME);
		const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
		manifest.fonts = [{ family: 'Inter', src: 'fonts/inter-400.woff2', weight: 400 }];
		await writeFile(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');

		const client = createMockApiClient();
		await executePublish({
			cwd: projectDir,
			apiClient: client,
			homeDir: fakeHome,
		});

		const updateCall = (client.updateProject as ReturnType<typeof vi.fn>).mock.calls[0];
		const payload = updateCall[3] as Record<string, unknown>;
		const images = payload.images as Array<{ path: string; data: string }>;
		expect(images).toBeDefined();
		expect(images.find((i) => i.path === 'fonts/inter-400.woff2')).toBeDefined();
	});
});
