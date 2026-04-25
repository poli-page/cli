import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../../src/commands/init.js';
import { executeVersionsList, executeVersionsDownload } from '../../src/commands/versions.js';
import { writeCredentials } from '../../src/credentials.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';
import type { ApiClient } from '../../src/api-client.js';

const sampleVersions = [
	{
		id: 'ver_3',
		version: '1.1.0',
		major: 1,
		minor: 1,
		patch: 0,
		createdAt: '2026-04-20T10:00:00Z',
	},
	{
		id: 'ver_2',
		version: '1.0.1',
		major: 1,
		minor: 0,
		patch: 1,
		createdAt: '2026-04-19T10:00:00Z',
	},
	{
		id: 'ver_1',
		version: '1.0.0',
		major: 1,
		minor: 0,
		patch: 0,
		createdAt: '2026-04-18T10:00:00Z',
	},
];

const sampleBundle = {
	version: '1.0.0',
	manifest: {
		project: { name: 'test-project', version: '1.0.0' },
		fonts: [],
		templates: [{ name: 'invoice', template: 'invoice.html', mock: 'invoice.json' }],
	},
	templates: [
		{ path: 'invoice.html', content: '<html>Invoice</html>' },
		{ path: 'invoice.json', content: '{"number":"INV-001"}' },
	],
	images: [
		{ path: 'images/logo.png', data: Buffer.from('fake-png').toString('base64') },
	],
	tailwindCss: '@import "tailwindcss";',
};

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
		updateProject: async () => {},
		createApiKey: async () => ({
			key: 'pp_test_mock123',
			info: { id: 'key_1', name: 'CLI (test)', environment: 'test' },
		}),
		renderPdf: async () => Buffer.from('fake-pdf'),
		publishVersion: async () => sampleVersions[0],
		listVersions: vi.fn(async () => sampleVersions),
		downloadVersion: vi.fn(async () => sampleBundle),
		...overrides,
	};
}

describe('poli versions', () => {
	let tempDir: string;
	let projectDir: string;
	let fakeHome: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-versions-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-home-'));
		projectDir = await executeInit('test-project', { cwd: tempDir });

		await writeCredentials(
			{
				session: 'mock-session',
				user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
				orgs: { 'acme-corp': { testKey: 'pp_test_abc' } },
			},
			fakeHome,
		);

		// Link project
		const manifestPath = join(projectDir, MANIFEST_FILENAME);
		const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
		manifest.cloud = { orgSlug: 'acme-corp', projectId: 'proj_abc123' };
		await writeFile(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	describe('versions list', () => {
		it('should return versions from API', async () => {
			const client = createMockApiClient();
			const versions = await executeVersionsList({
				cwd: projectDir,
				apiClient: client,
				homeDir: fakeHome,
			});

			expect(versions).toHaveLength(3);
			expect(versions[0].version).toBe('1.1.0');
			expect(client.listVersions).toHaveBeenCalledWith(
				'mock-session',
				'org_1',
				'proj_abc123',
			);
		});

		it('should throw if project is not linked', async () => {
			const manifestPath = join(projectDir, MANIFEST_FILENAME);
			const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
			delete manifest.cloud;
			await writeFile(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');

			await expect(
				executeVersionsList({
					cwd: projectDir,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				}),
			).rejects.toThrow(/not linked/);
		});
	});

	describe('versions download', () => {
		it('should download version bundle and extract files', async () => {
			const outputDir = join(tempDir, 'downloaded');
			await mkdir(outputDir, { recursive: true });

			const client = createMockApiClient();
			await executeVersionsDownload({
				version: '1.0.0',
				outputDir,
				cwd: projectDir,
				apiClient: client,
				homeDir: fakeHome,
			});

			expect(client.downloadVersion).toHaveBeenCalledWith(
				'mock-session',
				'org_1',
				'proj_abc123',
				'1.0.0',
			);

			// Check manifest was written
			const manifest = JSON.parse(
				await readFile(join(outputDir, MANIFEST_FILENAME), 'utf-8'),
			);
			expect(manifest.project.name).toBe('test-project');
			expect(manifest.cloud).toEqual({
				orgSlug: 'acme-corp',
				projectId: 'proj_abc123',
			});

			// Check template files
			const html = await readFile(
				join(outputDir, 'templates', 'invoice', 'invoice.html'),
				'utf-8',
			);
			expect(html).toContain('Invoice');

			const mock = await readFile(
				join(outputDir, 'templates', 'invoice', 'invoice.json'),
				'utf-8',
			);
			expect(JSON.parse(mock).number).toBe('INV-001');

			// Check assets
			expect(existsSync(join(outputDir, 'assets', 'images', 'logo.png'))).toBe(true);

			// Check tailwind.css
			const tw = await readFile(join(outputDir, 'tailwind.css'), 'utf-8');
			expect(tw).toContain('tailwindcss');
		});

		it('should throw if not logged in', async () => {
			const emptyHome = await mkdtemp(join(tmpdir(), 'poli-nologin-'));
			await expect(
				executeVersionsDownload({
					version: '1.0.0',
					outputDir: tempDir,
					cwd: projectDir,
					apiClient: createMockApiClient(),
					homeDir: emptyHome,
				}),
			).rejects.toThrow(/Not logged in/);
			await rm(emptyHome, { recursive: true, force: true });
		});
	});
});
