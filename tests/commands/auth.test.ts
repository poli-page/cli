import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	executeLogout,
	executeWhoami,
	executeDeviceLogin,
} from '../../src/commands/auth.js';
import { readCredentials, writeCredentials } from '../../src/credentials.js';
import { writeManifest } from '../../src/manifest.js';
import type { ApiClient, MeResponse } from '../../src/api-client.js';

function sessionMe(): MeResponse {
	return {
		auth: { mode: 'session', keyType: 'session', environment: null },
		user: {
			id: 'user_1',
			email: 'xavier@test.com',
			name: 'Xavier',
			username: 'xavier',
		},
		key: null,
		org: {
			id: 'org_uuid_acme',
			slug: 'acme',
			name: 'Acme',
			tier: 'free',
			lifecycleStatus: 'active',
		},
	};
}

function apiKeyMe(): MeResponse {
	return {
		auth: { mode: 'api-key', keyType: 'live', environment: 'live' },
		user: null,
		key: {
			id: 'k1',
			name: 'CI key',
			prefix: 'pp_live_',
			preview: 'pp_live_xxx…abcd',
			createdAt: '2026-05-01T00:00:00.000Z',
			lastUsedAt: null,
		},
		org: {
			id: 'org_uuid_acme',
			slug: 'acme',
			name: 'Acme',
			tier: 'starter',
			lifecycleStatus: 'active',
		},
	};
}

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
		deviceRequest: async () => ({
			deviceCode: 'device-code-123',
			userCode: 'ABCD-1234',
			verificationUrl: 'https://app.poli.page/auth/device?code=ABCD-1234',
			expiresIn: 600,
			interval: 0.01,
		}),
		devicePoll: async () => ({
			status: 'confirmed' as const,
			sessionToken: 'device-session-token',
			user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
		}),
		getOrganizations: async () => [
			{ id: 'org_1', name: 'Acme Corp', slug: 'acme-corp' },
		],
		listProjects: async () => [],
		createProject: async () => ({ id: 'proj_1' }),
		updateProject: async () => {},
		createApiKey: async () => ({
			key: 'pp_test_mock',
			info: { id: 'key_1', name: 'CLI (test)', environment: 'test' },
		}),
		renderPdf: async () => ({ pdf: Buffer.from('fake-pdf'), environment: 'sandbox' }),
		renderThumbnails: async () => [],
		publishVersion: async () => ({
			id: 'v_1',
			version: '1.0.0',
			major: 1,
			minor: 0,
			patch: 0,
			createdAt: new Date().toISOString(),
		}),
		listVersions: async () => [],
		downloadVersion: async () => ({ manifest: {}, templates: [] }),
		getMe: async () => sessionMe(),
		...overrides,
	};
}

describe('auth commands', () => {
	let fakeHome: string;

	beforeEach(async () => {
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-auth-'));
	});

	afterEach(async () => {
		await rm(fakeHome, { recursive: true, force: true });
	});

	describe('executeDeviceLogin', () => {
		it('stores credentials after successful device flow', async () => {
			const openedUrls: string[] = [];
			const userCodes: string[] = [];

			const credentials = await executeDeviceLogin({
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
				openUrl: async (url) => {
					openedUrls.push(url);
				},
				onUserCode: (code) => {
					userCodes.push(code);
				},
			});

			expect(credentials.user.name).toBe('Xavier');
			expect(credentials.session).toBe('device-session-token');
			expect(openedUrls).toEqual(['https://app.poli.page/auth/device?code=ABCD-1234']);
			expect(userCodes).toEqual(['ABCD-1234']);

			const stored = await readCredentials(fakeHome);
			expect(stored?.session).toBe('device-session-token');
		});

		it('fetches and stores organizations', async () => {
			const credentials = await executeDeviceLogin({
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
				openUrl: async () => {},
			});

			expect(credentials.orgs).toHaveProperty('acme-corp');
		});

		it('handles expired device code', async () => {
			const client = createMockApiClient({
				devicePoll: async () => ({ status: 'expired' as const }),
			});

			await expect(
				executeDeviceLogin({
					apiClient: client,
					homeDir: fakeHome,
					openUrl: async () => {},
				})
			).rejects.toThrow(/expired/);
		});

		it('handles request failure', async () => {
			const client = createMockApiClient({
				deviceRequest: async () => {
					throw new Error('API error (500): Internal error');
				},
			});

			await expect(
				executeDeviceLogin({
					apiClient: client,
					homeDir: fakeHome,
					openUrl: async () => {},
				})
			).rejects.toThrow(/Internal error/);
		});

		it('handles orgs fetch failure gracefully', async () => {
			const client = createMockApiClient({
				getOrganizations: async () => {
					throw new Error('API error (500): Internal error');
				},
			});

			const credentials = await executeDeviceLogin({
				apiClient: client,
				homeDir: fakeHome,
				openUrl: async () => {},
			});

			expect(Object.keys(credentials.orgs)).toHaveLength(0);
		});
	});

	describe('executeLogout', () => {
		it('clears stored credentials', async () => {
			await writeCredentials(
				{
					session: 'token',
					user: { id: '1', name: 'X', email: 'x@x.com' },
					orgs: {},
				},
				fakeHome
			);

			await executeLogout(fakeHome);
			const result = await readCredentials(fakeHome);
			expect(result).toBeNull();
		});

		it('does not throw if no credentials exist', async () => {
			await expect(executeLogout(fakeHome)).resolves.not.toThrow();
		});
	});

	describe('executeWhoami', () => {
		let projectDir: string;
		let savedEnvKey: string | undefined;

		beforeEach(async () => {
			projectDir = await mkdtemp(join(tmpdir(), 'poli-whoami-'));
			savedEnvKey = process.env.POLI_PAGE_API_KEY;
			delete process.env.POLI_PAGE_API_KEY;
		});

		afterEach(async () => {
			await rm(projectDir, { recursive: true, force: true });
			if (savedEnvKey === undefined) {
				delete process.env.POLI_PAGE_API_KEY;
			} else {
				process.env.POLI_PAGE_API_KEY = savedEnvKey;
			}
		});

		async function setupLinkedProject() {
			await writeManifest(projectDir, {
				project: { name: 'p', version: '1.0' },
				cloud: {
					orgSlug: 'acme',
					orgId: 'org_uuid_acme',
					projectSlug: 'p',
					projectId: 'proj_1',
				},
			});
		}

		async function setupSessionCreds() {
			await writeCredentials(
				{
					session: 'session-token',
					user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
					orgs: { acme: {} },
				},
				fakeHome
			);
		}

		it('returns session-mode payload when credentials + manifest.cloud.orgId are present', async () => {
			await setupSessionCreds();
			await setupLinkedProject();

			let receivedAuth = '';
			let receivedOrgId: string | undefined;
			const client = createMockApiClient({
				getMe: async (auth, orgId) => {
					receivedAuth = auth;
					receivedOrgId = orgId;
					return sessionMe();
				},
			});

			const result = await executeWhoami({
				cwd: projectDir,
				homeDir: fakeHome,
				apiClient: client,
			});

			expect(result.mode).toBe('session');
			expect(receivedAuth).toBe('Bearer session-token');
			expect(receivedOrgId).toBe('org_uuid_acme');
			expect(result.payload.user?.email).toBe('xavier@test.com');
			expect(result.payload.org?.slug).toBe('acme');
		});

		it('returns api-key-mode payload when POLI_PAGE_API_KEY is set', async () => {
			process.env.POLI_PAGE_API_KEY = 'pp_live_envkey';

			let receivedAuth = '';
			let receivedOrgId: string | undefined;
			const client = createMockApiClient({
				getMe: async (auth, orgId) => {
					receivedAuth = auth;
					receivedOrgId = orgId;
					return apiKeyMe();
				},
			});

			const result = await executeWhoami({
				cwd: projectDir,
				homeDir: fakeHome,
				apiClient: client,
			});

			expect(result.mode).toBe('api-key');
			expect(receivedAuth).toBe('Bearer pp_live_envkey');
			expect(receivedOrgId).toBeUndefined();
			expect(result.payload.key?.preview).toBe('pp_live_xxx…abcd');
			expect(result.payload.auth.environment).toBe('live');
		});

		it('throws "Not logged in" when neither credentials nor env var are set', async () => {
			await expect(
				executeWhoami({
					cwd: projectDir,
					homeDir: fakeHome,
					apiClient: createMockApiClient(),
				})
			).rejects.toThrow(/Not logged in/i);
		});

		it('throws a whoami-specific friendly error when session is present but no linked project', async () => {
			await setupSessionCreds();
			// no manifest.cloud.orgId — bare project dir
			await writeFile(
				join(projectDir, 'poli-page.json'),
				JSON.stringify({ project: { name: 'p', version: '1.0' } }),
				'utf-8'
			);

			await expect(
				executeWhoami({
					cwd: projectDir,
					homeDir: fakeHome,
					apiClient: createMockApiClient(),
				})
			).rejects.toThrow(/Run `poli whoami` inside a linked project/i);
		});

		it('does not require a manifest in api-key mode', async () => {
			process.env.POLI_PAGE_API_KEY = 'pp_test_envkey';

			const client = createMockApiClient({
				getMe: async () => apiKeyMe(),
			});

			const result = await executeWhoami({
				cwd: projectDir,
				homeDir: fakeHome,
				apiClient: client,
			});
			expect(result.mode).toBe('api-key');
		});
	});
});
