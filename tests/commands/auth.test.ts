import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeLogin, executeLogout, executeWhoami, executeDeviceLogin } from '../../src/commands/auth.js';
import { readCredentials, writeCredentials } from '../../src/credentials.js';
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
		deviceRequest: async () => ({
			deviceCode: 'device-code-123',
			userCode: 'ABCD-1234',
			verificationUrl: 'https://app.poli.page/auth/device?code=ABCD-1234',
			expiresIn: 600,
			interval: 0.01, // fast polling for tests
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
		createApiKey: async () => ({
			key: 'pp_test_mock',
			info: { id: 'key_1', name: 'CLI (test)', environment: 'test' },
		}),
		renderPdf: async () => Buffer.from('fake-pdf'),
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

	describe('executeLogin', () => {
		it('should store credentials after successful login', async () => {
			const credentials = await executeLogin({
				email: 'xavier@test.com',
				password: 'password',
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			expect(credentials.user.name).toBe('Xavier');
			expect(credentials.session).toBe('mock-session-token');

			const stored = await readCredentials(fakeHome);
			expect(stored?.user.email).toBe('xavier@test.com');
		});

		it('should fetch and store organizations', async () => {
			const credentials = await executeLogin({
				email: 'xavier@test.com',
				password: 'password',
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			expect(credentials.orgs).toHaveProperty('acme-corp');
		});

		it('should handle login failure', async () => {
			const client = createMockApiClient({
				signIn: async () => {
					throw new Error('API error (401): Invalid credentials');
				},
			});

			await expect(
				executeLogin({
					email: 'wrong@test.com',
					password: 'wrong',
					apiClient: client,
					homeDir: fakeHome,
				})
			).rejects.toThrow(/Invalid credentials/);
		});

		it('should handle orgs fetch failure gracefully', async () => {
			const client = createMockApiClient({
				getOrganizations: async () => {
					throw new Error('API error (500): Internal error');
				},
			});

			const credentials = await executeLogin({
				email: 'xavier@test.com',
				password: 'password',
				apiClient: client,
				homeDir: fakeHome,
			});

			expect(Object.keys(credentials.orgs)).toHaveLength(0);
		});
	});

	describe('executeDeviceLogin', () => {
		it('should store credentials after successful device flow', async () => {
			const openedUrls: string[] = [];
			const userCodes: string[] = [];

			const credentials = await executeDeviceLogin({
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
				openUrl: async (url) => { openedUrls.push(url); },
				onUserCode: (code) => { userCodes.push(code); },
			});

			expect(credentials.user.name).toBe('Xavier');
			expect(credentials.session).toBe('device-session-token');
			expect(openedUrls).toEqual(['https://app.poli.page/auth/device?code=ABCD-1234']);
			expect(userCodes).toEqual(['ABCD-1234']);

			const stored = await readCredentials(fakeHome);
			expect(stored?.session).toBe('device-session-token');
		});

		it('should fetch and store organizations', async () => {
			const credentials = await executeDeviceLogin({
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
				openUrl: async () => {},
			});

			expect(credentials.orgs).toHaveProperty('acme-corp');
		});

		it('should handle expired device code', async () => {
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

		it('should handle request failure', async () => {
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

		it('should handle orgs fetch failure gracefully', async () => {
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
		it('should clear stored credentials', async () => {
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

		it('should not throw if no credentials exist', async () => {
			await expect(executeLogout(fakeHome)).resolves.not.toThrow();
		});
	});

	describe('executeWhoami', () => {
		it('should return user info when logged in', async () => {
			await writeCredentials(
				{
					session: 'token',
					user: { id: '1', name: 'Xavier', email: 'xavier@test.com' },
					orgs: { 'acme-corp': {}, 'other-org': {} },
				},
				fakeHome
			);

			const info = await executeWhoami(fakeHome);
			expect(info).not.toBeNull();
			expect(info!.user.name).toBe('Xavier');
			expect(info!.user.email).toBe('xavier@test.com');
			expect(info!.orgs).toEqual(['acme-corp', 'other-org']);
		});

		it('should return null when not logged in', async () => {
			const info = await executeWhoami(fakeHome);
			expect(info).toBeNull();
		});
	});
});
