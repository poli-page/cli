import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../../src/commands/init.js';
import { executeLink, executeUnlink } from '../../src/commands/link.js';
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
			{ id: 'org_2', name: 'Beta Inc', slug: 'beta-inc' },
		],
		listProjects: async () => [],
		createProject: async () => ({ id: 'proj_abc123' }),
		createApiKey: async () => ({
			key: 'pp_test_mock123',
			info: { id: 'key_1', name: 'CLI (test)', environment: 'test' },
		}),
		renderPdf: async () => Buffer.from('fake-pdf'),
		...overrides,
	};
}

describe('poli link / unlink', () => {
	let tempDir: string;
	let projectDir: string;
	let fakeHome: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-link-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-home-'));
		projectDir = await executeInit('test-project', { cwd: tempDir });

		// Simulate logged-in user
		await writeCredentials(
			{
				session: 'mock-session',
				user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
				orgs: { 'acme-corp': { testKey: 'pp_test_abc' } },
			},
			fakeHome
		);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	describe('executeLink', () => {
		it('should add cloud config to poli-page.json', async () => {
			await executeLink({
				cwd: projectDir,
				orgSlug: 'acme-corp',
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			const manifest = JSON.parse(
				await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
			);

			expect(manifest.cloud).toEqual({
				orgSlug: 'acme-corp',
				projectId: 'proj_abc123',
			});
		});

		it('should throw if not logged in', async () => {
			const emptyHome = await mkdtemp(join(tmpdir(), 'poli-nologin-'));
			await expect(
				executeLink({
					cwd: projectDir,
					orgSlug: 'acme-corp',
					apiClient: createMockApiClient(),
					homeDir: emptyHome,
				})
			).rejects.toThrow(/Not logged in/);
			await rm(emptyHome, { recursive: true, force: true });
		});

		it('should throw if no poli-page.json', async () => {
			await expect(
				executeLink({
					cwd: tempDir + '/nonexistent',
					orgSlug: 'acme-corp',
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/poli-page\.json/);
		});

		it('should throw if project is already linked', async () => {
			await executeLink({
				cwd: projectDir,
				orgSlug: 'acme-corp',
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			await expect(
				executeLink({
					cwd: projectDir,
					orgSlug: 'acme-corp',
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/already linked/);
		});
	});

	describe('executeUnlink', () => {
		it('should remove cloud config from poli-page.json', async () => {
			await executeLink({
				cwd: projectDir,
				orgSlug: 'acme-corp',
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			await executeUnlink({ cwd: projectDir });

			const manifest = JSON.parse(
				await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
			);
			expect(manifest.cloud).toBeUndefined();
		});

		it('should throw if not linked', async () => {
			await expect(executeUnlink({ cwd: projectDir })).rejects.toThrow(
				/not linked/
			);
		});

		it('should throw if no poli-page.json', async () => {
			await expect(
				executeUnlink({ cwd: tempDir + '/nonexistent' })
			).rejects.toThrow(/poli-page\.json/);
		});
	});
});
