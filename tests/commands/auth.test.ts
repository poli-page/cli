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
		pushVersion: async () => ({
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

		it('emits a non-blocking info message when POLI_PAGE_API_KEY is set in the environment', async () => {
			const infoMessages: string[] = [];

			const credentials = await executeDeviceLogin({
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
				envApiKey: 'pp_sa_live_abc123def456',
				onEnvVarInfo: (msg) => infoMessages.push(msg),
				openUrl: async () => {},
			});

			expect(infoMessages).toHaveLength(1);
			expect(infoMessages[0]).toMatch(/POLI_PAGE_API_KEY/);
			expect(infoMessages[0]).toMatch(/session.*will be preferred|will be ignored/i);
			// Device flow still runs and stores credentials.
			expect(credentials.session).toBe('device-session-token');
		});

		it('does not emit info message when env var is not set', async () => {
			const infoMessages: string[] = [];

			await executeDeviceLogin({
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
				envApiKey: undefined,
				onEnvVarInfo: (msg) => infoMessages.push(msg),
				openUrl: async () => {},
			});

			expect(infoMessages).toHaveLength(0);
		});

		it('persists the explicit apiUrl in credentials when provided', async () => {
			const credentials = await executeDeviceLogin({
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
				apiUrl: 'https://api-develop.poli.page',
				openUrl: async () => {},
			});

			expect(credentials.apiUrl).toBe('https://api-develop.poli.page');

			const stored = await readCredentials(fakeHome);
			expect(stored?.apiUrl).toBe('https://api-develop.poli.page');
		});

		it('does not write apiUrl when neither option nor env var is set', async () => {
			const savedEnv = process.env.POLI_API_URL;
			delete process.env.POLI_API_URL;
			try {
				const credentials = await executeDeviceLogin({
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
					openUrl: async () => {},
				});
				expect(credentials.apiUrl).toBeUndefined();
			} finally {
				if (savedEnv !== undefined) {
					process.env.POLI_API_URL = savedEnv;
				}
			}
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

		it('returns session-no-org mode with user + orgs when session is present but no linked project', async () => {
			await setupSessionCreds();
			// no manifest at all
			const client = createMockApiClient({
				getOrganizations: async () => [
					{ id: 'org_uuid_acme', slug: 'acme', name: 'Acme' },
					{ id: 'org_uuid_other', slug: 'other', name: 'Other Co' },
				],
			});

			const result = await executeWhoami({
				cwd: projectDir,
				homeDir: fakeHome,
				apiClient: client,
			});

			expect(result.mode).toBe('session-no-org');
			if (result.mode !== 'session-no-org') throw new Error('mode mismatch');
			expect(result.user.email).toBe('xavier@test.com');
			expect(result.orgs).toHaveLength(2);
			expect(result.orgs.map((o) => o.slug)).toEqual(['acme', 'other']);
		});

		it('returns session-no-org when session is present in a non-linked project (manifest without cloud)', async () => {
			await setupSessionCreds();
			await writeFile(
				join(projectDir, 'poli-page.json'),
				JSON.stringify({ project: { name: 'p', version: '1.0' } }),
				'utf-8'
			);

			const client = createMockApiClient({
				getOrganizations: async () => [
					{ id: 'org_uuid_acme', slug: 'acme', name: 'Acme' },
				],
			});

			const result = await executeWhoami({
				cwd: projectDir,
				homeDir: fakeHome,
				apiClient: client,
			});

			expect(result.mode).toBe('session-no-org');
		});

		it('surfaces "Not logged in" if the session is rejected when listing orgs', async () => {
			await setupSessionCreds();
			const client = createMockApiClient({
				getOrganizations: async () => {
					throw new Error('API error (401): Unauthorized');
				},
			});

			await expect(
				executeWhoami({
					cwd: projectDir,
					homeDir: fakeHome,
					apiClient: client,
				})
			).rejects.toThrow(/Not logged in/i);
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
