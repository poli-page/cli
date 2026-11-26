import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { executeLogout, executeWhoami, executeDeviceLogin } from '../../src/commands/auth.js';
import { readCredentials, writeCredentials } from '../../src/credentials.js';
import { writeManifest } from '../../src/manifest.js';
import { createProgram } from '../../src/program.js';
import { CREDENTIALS_DIR } from '../../src/constants.js';
import { ExitCode } from '../../src/exit-codes.js';
import type { ApiClient, MeResponse } from '../../src/api-client.js';
import { createFakeApiClient } from '../helpers/fake-api-client.js';
import { testApiKey } from '../helpers/api-key.js';
import { readOnlyDirBlocksUnlink } from '../helpers/dir-permissions.js';

const openBrowser = vi.hoisted(() => vi.fn(async (_url: string) => {}));
vi.mock('open', () => ({ default: openBrowser }));

function sessionMe(): MeResponse {
	return {
		auth: { mode: 'session', keyType: null, environment: null, role: 'owner' },
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
		auth: { mode: 'api-key', keyType: 'standard', environment: 'live', role: null },
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
	return createFakeApiClient({
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
		getOrganizations: async () => [{ id: 'org_1', name: 'Acme Corp', slug: 'acme-corp' }],
		...overrides,
	});
}

describe('auth commands', () => {
	let fakeHome: string;

	beforeEach(async () => {
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-auth-'));
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
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
			expect(infoMessages[0]).toMatch(/whoami, publish, render and documents keep using it instead of your session/i);
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
			vi.stubEnv('POLI_API_URL', 'https://api-develop.poli.page');
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

		it('does not persist POLI_API_URL on its own: only the apiUrl the caller passes', async () => {
			vi.stubEnv('POLI_API_URL', 'https://api.poli.page');
			try {
				const credentials = await executeDeviceLogin({
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
					openUrl: async () => {},
				});
				expect(credentials.apiUrl).toBeUndefined();
				expect((await readCredentials(fakeHome))?.apiUrl).toBeUndefined();
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it('stores the apiUrl as its validated origin', async () => {
			vi.stubEnv('POLI_API_URL', 'https://api-develop.poli.page');
			const credentials = await executeDeviceLogin({
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
				apiUrl: 'https://api-develop.poli.page/',
				openUrl: async () => {},
			});
			expect(credentials.apiUrl).toBe('https://api-develop.poli.page');
		});

		it('refuses an apiUrl that is not the API this login talks to, before the device flow starts', async () => {
			vi.stubEnv('POLI_API_URL', 'https://api.poli.page');
			const deviceRequest = vi.fn();
			await expect(
				executeDeviceLogin({
					apiClient: createMockApiClient({ deviceRequest }),
					homeDir: fakeHome,
					apiUrl: 'https://api-develop.poli.page',
					openUrl: async () => {},
				})
			).rejects.toMatchObject({ exitCode: ExitCode.INVALID_USAGE });
			expect(deviceRequest).not.toHaveBeenCalled();
			expect(await readCredentials(fakeHome)).toBeNull();
		});

		it('refuses an untrusted apiUrl before the device flow starts', async () => {
			const deviceRequest = vi.fn();
			await expect(
				executeDeviceLogin({
					apiClient: createMockApiClient({ deviceRequest }),
					homeDir: fakeHome,
					apiUrl: 'https://evil.com',
					openUrl: async () => {},
				})
			).rejects.toMatchObject({ exitCode: ExitCode.INVALID_USAGE });
			expect(deviceRequest).not.toHaveBeenCalled();
		});

		it.each([
			'file:///etc/passwd',
			'smb://attacker.example/share',
			'poli-evil://run',
			'https://evil.com/device',
		])('does not open the verification URL %s, polls nothing and stores nothing', async (url) => {
			const opened: string[] = [];
			const userCodes: string[] = [];
			const devicePoll = vi.fn();
			await expect(
				executeDeviceLogin({
					apiClient: createMockApiClient({
						deviceRequest: async () => ({
							deviceCode: 'dc',
							userCode: 'UC',
							verificationUrl: url,
							expiresIn: 60,
							interval: 0,
						}),
						devicePoll,
					}),
					homeDir: fakeHome,
					openUrl: async (u) => {
						opened.push(u);
					},
					onUserCode: (code) => userCodes.push(code),
				})
			).rejects.toMatchObject({
				exitCode: ExitCode.NETWORK_OR_API_ERROR,
				message: expect.stringContaining(new URL(url).href),
			});
			expect(opened).toEqual([]);
			expect(userCodes).toEqual([]);
			expect(devicePoll).not.toHaveBeenCalled();
			expect(await readCredentials(fakeHome)).toBeNull();
		});
	});

	describe('poli login (the command)', () => {
		const DEVICE_SITE = 'https://app.poli.page/auth/device?code=UC';
		let projectDir: string;
		let logs: string[];
		let output: string;
		let verificationUrl: string;
		let fetchedUrls: string[];
		let savedExitCode: typeof process.exitCode;

		beforeEach(async () => {
			projectDir = await mkdtemp(join(tmpdir(), 'poli-login-cmd-'));
			vi.stubEnv('HOME', fakeHome);
			vi.stubEnv('USERPROFILE', fakeHome);
			vi.stubEnv('POLI_API_URL', '');
			vi.stubEnv('POLI_ALLOW_INSECURE_API', '');
			vi.stubEnv('POLI_PAGE_API_KEY', '');
			vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
			openBrowser.mockReset();
			verificationUrl = DEVICE_SITE;
			fetchedUrls = [];
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: string) => {
					fetchedUrls.push(url);
					const path = new URL(url).pathname;
					const body =
						path === '/api/device/request'
							? { deviceCode: 'dc', userCode: 'UC', verificationUrl, expiresIn: 60, interval: 0 }
							: path === '/api/device/poll'
								? { status: 'confirmed', sessionToken: 'tok', user: { id: 'u', name: 'X', email: 'x@test.com' } }
								: [];
					return new Response(JSON.stringify(body), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				})
			);
			logs = [];
			vi.spyOn(console, 'log').mockImplementation((msg: unknown = '') => {
				logs.push(stripVTControlCharacters(String(msg)));
			});
			vi.spyOn(console, 'error').mockImplementation(() => {});
			output = '';
			vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
				output += stripVTControlCharacters(String(chunk));
				return true;
			});
			savedExitCode = process.exitCode;
			process.exitCode = undefined;
		});

		afterEach(async () => {
			process.exitCode = savedExitCode;
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
			await rm(projectDir, { recursive: true, force: true });
		});

		function poli(...args: string[]) {
			return createProgram().parseAsync(args, { from: 'user' });
		}

		async function linkProject(apiUrl: string) {
			await writeManifest(projectDir, {
				project: { name: 'p' },
				cloud: { orgSlug: 'acme', orgId: 'org_1', projectSlug: 'p', projectId: 'proj_1', apiUrl },
			});
		}

		it.each(['https://api.poli.page', 'https://api-develop.poli.page'])(
			'in a folder whose manifest sets cloud.apiUrl %s, stores no apiUrl',
			async (apiUrl) => {
				await linkProject(apiUrl);
				await poli('login');
				expect(process.exitCode).toBeUndefined();
				const stored = await readCredentials(fakeHome);
				expect(stored?.session).toBe('tok');
				expect(stored?.apiUrl).toBeUndefined();
				expect(fetchedUrls.every((u) => u.startsWith('https://api.poli.page/'))).toBe(true);
			}
		);

		it('stores the --api-url origin and names that host before the device flow', async () => {
			await poli('--api-url', 'https://api-develop.poli.page', 'login');
			expect((await readCredentials(fakeHome))?.apiUrl).toBe('https://api-develop.poli.page');
			expect(logs[0]).toBe('Logging in to api-develop.poli.page');
			expect(openBrowser).toHaveBeenCalledWith(DEVICE_SITE);
		});

		it('stores a POLI_API_URL the user set', async () => {
			vi.stubEnv('POLI_API_URL', 'https://api-develop.poli.page');
			await poli('login');
			expect((await readCredentials(fakeHome))?.apiUrl).toBe('https://api-develop.poli.page');
		});

		it('keeps the apiUrl an earlier login stored', async () => {
			await writeCredentials(
				{
					apiUrl: 'https://api-develop.poli.page',
					origin: 'https://api-develop.poli.page',
					session: 'old',
					user: { id: 'u', name: 'X', email: 'x@test.com' },
					orgs: {},
				},
				fakeHome
			);
			await poli('login');
			const stored = await readCredentials(fakeHome);
			expect(stored?.session).toBe('tok');
			expect(stored?.apiUrl).toBe('https://api-develop.poli.page');
			expect(logs[0]).toBe('Logging in to api-develop.poli.page');
		});

		it('names the default API host', async () => {
			await poli('login');
			expect(logs[0]).toBe('Logging in to api.poli.page');
		});

		it('refuses to open a verification URL on another site: prints it and exits non-zero', async () => {
			verificationUrl = 'smb://attacker.example/share';
			await poli('login');
			expect(openBrowser).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(ExitCode.NETWORK_OR_API_ERROR);
			expect(output).toContain('smb://attacker.example/share');
			expect(await readCredentials(fakeHome)).toBeNull();
		});
	});

	describe('executeLogout', () => {
		async function storeSession(origin?: string) {
			await writeCredentials(
				{
					...(origin ? { origin } : {}),
					session: 'token',
					user: { id: '1', name: 'X', email: 'x@x.com' },
					orgs: {},
				},
				fakeHome
			);
		}

		it('removes the credentials file before it revokes the stored session', async () => {
			await storeSession();
			const revoked: Array<{ session: string; fileStillThere: boolean }> = [];
			const apiClient = createFakeApiClient({
				signOut: async (session) => {
					revoked.push({ session, fileStillThere: (await readCredentials(fakeHome)) !== null });
				},
			});

			const result = await executeLogout({ homeDir: fakeHome, apiClient });

			expect(revoked).toEqual([{ session: 'token', fileStillThere: false }]);
			expect(result).toEqual({ status: 'revoked', origin: 'https://api.poli.page' });
			expect(await readCredentials(fakeHome)).toBeNull();
		});

		it('removes the credentials file when the revoke fails, and says why', async () => {
			await storeSession();
			const apiClient = createFakeApiClient({
				signOut: async () => {
					throw new Error('HTTP 503');
				},
			});

			const result = await executeLogout({ homeDir: fakeHome, apiClient });

			expect(result).toEqual({
				status: 'revoke-failed',
				origin: 'https://api.poli.page',
				reason: 'HTTP 503',
			});
			expect(await readCredentials(fakeHome)).toBeNull();
		});

		it.skipIf(!readOnlyDirBlocksUnlink)('still revokes the session when the file cannot be removed, and says the file is kept', async () => {
			await storeSession();
			const revoked: string[] = [];
			const apiClient = createFakeApiClient({
				signOut: async (session) => {
					revoked.push(session);
				},
			});
			const dir = join(fakeHome, CREDENTIALS_DIR);
			await chmod(dir, 0o500);
			try {
				const result = await executeLogout({ homeDir: fakeHome, apiClient });
				expect(result).toEqual({
					status: 'revoked',
					origin: 'https://api.poli.page',
					fileError: expect.stringContaining('EACCES'),
				});
			} finally {
				await chmod(dir, 0o700);
			}
			expect(revoked).toEqual(['token']);
			expect(await readCredentials(fakeHome)).not.toBeNull();
		});

		it('makes no API call when no credentials exist', async () => {
			const apiClient = createFakeApiClient({});
			await expect(executeLogout({ homeDir: fakeHome, apiClient })).resolves.toEqual({
				status: 'not-logged-in',
			});
		});
	});

	describe('poli logout', () => {
		let logs: string[];
		let errors: string[];
		let fetched: Array<{ url: string; authorization?: string }>;
		let signOutStatus: number;
		let savedExitCode: typeof process.exitCode;

		beforeEach(() => {
			vi.stubEnv('HOME', fakeHome);
			vi.stubEnv('USERPROFILE', fakeHome);
			vi.stubEnv('POLI_API_URL', '');
			vi.stubEnv('POLI_ALLOW_INSECURE_API', '');
			fetched = [];
			signOutStatus = 200;
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: string, init: RequestInit = {}) => {
					const headers = init.headers as Record<string, string>;
					fetched.push({ url, authorization: headers.Authorization });
					return new Response('{}', {
						status: signOutStatus,
						headers: { 'Content-Type': 'application/json' },
					});
				})
			);
			logs = [];
			errors = [];
			vi.spyOn(console, 'log').mockImplementation((msg: unknown = '') => {
				logs.push(stripVTControlCharacters(String(msg)));
			});
			vi.spyOn(console, 'error').mockImplementation((msg: unknown = '') => {
				errors.push(stripVTControlCharacters(String(msg)));
			});
			savedExitCode = process.exitCode;
			process.exitCode = undefined;
		});

		afterEach(() => {
			process.exitCode = savedExitCode;
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
		});

		async function storeSession(origin: string) {
			await writeCredentials(
				{ origin, session: 'tok', user: { id: 'u', name: 'X', email: 'x@test.com' }, orgs: {} },
				fakeHome
			);
		}

		it('revokes the session at the origin that issued it and says so', async () => {
			await storeSession('https://api-develop.poli.page');

			await createProgram().parseAsync(['logout'], { from: 'user' });

			expect(fetched).toEqual([
				{ url: 'https://api-develop.poli.page/api/auth/sign-out', authorization: 'Bearer tok' },
			]);
			expect(logs).toEqual(['Logged out. Session revoked on https://api-develop.poli.page.']);
			expect(errors).toEqual([]);
			expect(process.exitCode).toBeUndefined();
			expect(await readCredentials(fakeHome)).toBeNull();
		});

		it('warns when the revoke fails, still removes the file and exits 0', async () => {
			await storeSession('https://api.poli.page');
			signOutStatus = 503;

			await createProgram().parseAsync(['logout'], { from: 'user' });

			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatch(
				/^Warning: the session was not revoked on https:\/\/api\.poli\.page: it stays valid until it expires\.\n {2}\S/
			);
			expect(logs).toEqual(['Logged out: local credentials removed.']);
			expect(process.exitCode).toBeUndefined();
			expect(await readCredentials(fakeHome)).toBeNull();
		});

		it('sends nothing to an origin the CLI does not trust, still removes the file and exits 0', async () => {
			await storeSession('not a url');

			await createProgram().parseAsync(['logout'], { from: 'user' });

			expect(fetched).toEqual([]);
			expect(errors).toEqual([
				expect.stringMatching(/^Warning: the session was not revoked on not a url: it stays valid until it expires\.\n {2}Invalid API URL/),
			]);
			expect(process.exitCode).toBeUndefined();
			expect(await readCredentials(fakeHome)).toBeNull();
		});

		it('puts a multi-line reason (API unreachable) after the one-line warning', async () => {
			await storeSession('https://api.poli.page');
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => {
					throw new TypeError('fetch failed');
				})
			);

			await createProgram().parseAsync(['logout'], { from: 'user' });

			expect(errors).toHaveLength(1);
			const [first, ...rest] = errors[0].split('\n');
			expect(first).toBe(
				'Warning: the session was not revoked on https://api.poli.page: it stays valid until it expires.'
			);
			expect(rest.length).toBeGreaterThan(1);
			for (const line of rest) expect(line).toMatch(/^ {2,}\S/);
			expect(logs).toEqual(['Logged out: local credentials removed.']);
		});

		it('indents every line of a multi-line reason (an HTML error page)', async () => {
			await storeSession('https://api.poli.page');
			vi.stubGlobal(
				'fetch',
				vi.fn(
					async () =>
						new Response('<html>\n<body>Bad Gateway</body>\n</html>', {
							status: 502,
							headers: { 'Content-Type': 'text/html' },
						})
				)
			);

			await createProgram().parseAsync(['logout'], { from: 'user' });

			expect(errors).toHaveLength(1);
			const [, ...rest] = errors[0].split('\n');
			expect(rest).toEqual(['  <html>', '  <body>Bad Gateway</body>', '  </html>']);
		});

		it.skipIf(!readOnlyDirBlocksUnlink)('fails with exit 6 and keeps quiet about removal when the file cannot be deleted', async () => {
			await storeSession('https://api.poli.page');
			const dir = join(fakeHome, CREDENTIALS_DIR);
			await chmod(dir, 0o500);
			try {
				await createProgram().parseAsync(['logout'], { from: 'user' });
			} finally {
				await chmod(dir, 0o700);
			}

			expect(fetched).toEqual([
				{ url: 'https://api.poli.page/api/auth/sign-out', authorization: 'Bearer tok' },
			]);
			expect(logs).toEqual(['Session revoked on https://api.poli.page.']);
			expect(errors).toEqual([
				expect.stringMatching(/^Could not remove the local credentials file \(.*EACCES.*\)\. Delete it by hand\.$/s),
			]);
			expect(process.exitCode).toBe(ExitCode.INVALID_LOCAL_STATE);
			expect(await readCredentials(fakeHome)).not.toBeNull();
		});

		it('says logged out with nothing to revoke when no session is stored', async () => {
			await createProgram().parseAsync(['logout'], { from: 'user' });

			expect(fetched).toEqual([]);
			expect(logs).toEqual(['Logged out.']);
			expect(process.exitCode).toBeUndefined();
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
				project: { name: 'p' },
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
			process.env.POLI_PAGE_API_KEY = testApiKey('live');

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
			expect(receivedAuth).toBe(`Bearer ${testApiKey('live')}`);
			expect(receivedOrgId).toBeUndefined();
			expect(result.payload.key?.preview).toBe('pp_live_xxx…abcd');
			expect(result.payload.auth.environment).toBe('live');
			expect(result.mode === 'api-key' && result.sessionIgnored).toBe(false);
		});

		it('uses POLI_PAGE_API_KEY over a stored session in a linked project, and says so', async () => {
			await setupSessionCreds();
			await setupLinkedProject();
			process.env.POLI_PAGE_API_KEY = testApiKey('live');

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
			if (result.mode !== 'api-key') throw new Error('mode mismatch');
			expect(result.sessionIgnored).toBe(true);
			expect(receivedAuth).toBe(`Bearer ${testApiKey('live')}`);
			expect(receivedOrgId).toBeUndefined();
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
				JSON.stringify({ project: { name: 'p' } }),
				'utf-8'
			);

			const client = createMockApiClient({
				getOrganizations: async () => [{ id: 'org_uuid_acme', slug: 'acme', name: 'Acme' }],
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
			process.env.POLI_PAGE_API_KEY = testApiKey('test');

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
	describe('poli whoami (the command)', () => {
		const API_URL = 'https://api.poli.page';
		let projectDir: string;
		let me: MeResponse;
		let logs: string[];
		let errors: string[];
		let savedStdoutTTY: boolean | undefined;
		let savedExitCode: typeof process.exitCode;

		beforeEach(async () => {
			projectDir = await mkdtemp(join(tmpdir(), 'poli-whoami-cmd-'));
			vi.stubEnv('HOME', fakeHome);
			vi.stubEnv('USERPROFILE', fakeHome);
			vi.stubEnv('POLI_API_URL', API_URL);
			vi.stubEnv('POLI_PAGE_API_KEY', '');
			vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: string) =>
					url === `${API_URL}/v1/me`
						? new Response(JSON.stringify(me), {
								status: 200,
								headers: { 'Content-Type': 'application/json' },
							})
						: new Response('unexpected', { status: 500 })
				)
			);
			logs = [];
			vi.spyOn(console, 'log').mockImplementation((msg: unknown = '') => {
				logs.push(stripVTControlCharacters(String(msg)));
			});
			errors = [];
			vi.spyOn(console, 'error').mockImplementation((msg: unknown = '') => {
				errors.push(stripVTControlCharacters(String(msg)));
			});
			savedStdoutTTY = process.stdout.isTTY;
			process.stdout.isTTY = true;
			savedExitCode = process.exitCode;
			process.exitCode = undefined;
		});

		afterEach(async () => {
			process.stdout.isTTY = savedStdoutTTY as true;
			process.exitCode = savedExitCode;
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
			await rm(projectDir, { recursive: true, force: true });
		});

		function whoami() {
			return createProgram().parseAsync(['whoami'], { from: 'user' });
		}

		it("prints the session's role in the linked organization", async () => {
			await writeCredentials(
				{
					session: 'session-token',
					user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
					orgs: { acme: {} },
				},
				fakeHome
			);
			await writeManifest(projectDir, {
				project: { name: 'p' },
				cloud: {
					orgSlug: 'acme',
					orgId: 'org_uuid_acme',
					projectSlug: 'p',
					projectId: 'proj_1',
				},
			});
			me = { ...sessionMe(), auth: { ...sessionMe().auth, role: 'admin' } };
			await whoami();
			expect(logs).toEqual(['xavier@test.com @ acme (session, role=admin)']);
		});

		it("prints a service key's environment name and role", async () => {
			vi.stubEnv('POLI_PAGE_API_KEY', testApiKey('staging'));
			me = {
				...apiKeyMe(),
				auth: {
					mode: 'api-key',
					keyType: 'service',
					environment: 'staging',
					role: 'developer',
				},
				key: { ...apiKeyMe().key!, preview: 'pp_staging_xxx…abcd' },
			};
			await whoami();
			expect(logs).toEqual([
				'pp_staging_xxx…abcd @ acme (api-key, environment=staging, role=developer)',
			]);
		});

		it('prints no role for a standard key, which has none', async () => {
			vi.stubEnv('POLI_PAGE_API_KEY', testApiKey('live'));
			me = apiKeyMe();
			await whoami();
			expect(logs).toEqual(['pp_live_xxx…abcd @ acme (api-key, environment=live)']);
			expect(process.exitCode).toBeUndefined();
		});

		it('with a session and a key: prints the key and that the session is not used', async () => {
			await writeCredentials(
				{
					session: 'session-token',
					user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
					orgs: { acme: {} },
				},
				fakeHome
			);
			vi.stubEnv('POLI_PAGE_API_KEY', testApiKey('live'));
			me = apiKeyMe();
			await whoami();
			expect(logs).toEqual([
				'pp_live_xxx…abcd @ acme (api-key, environment=live)',
				'  POLI_PAGE_API_KEY is set, so it is used instead of your `poli login` session.',
			]);
			const [, init] = vi.mocked(fetch).mock.calls[0];
			expect((init?.headers as Record<string, string>).Authorization).toBe(
				`Bearer ${testApiKey('live')}`
			);
		});

		it('without a session or a key: exit 4 with "Not logged in" on stderr, and no API call', async () => {
			await whoami();
			expect(process.exitCode).toBe(ExitCode.NOT_AUTHENTICATED);
			expect(errors.join('\n')).toMatch(/^Not logged in/);
			expect(logs).toEqual([]);
			expect(fetch).not.toHaveBeenCalled();
		});

		it('an API error on /v1/me: exit 3 with its detail on stderr, nothing on stdout', async () => {
			vi.stubEnv('POLI_PAGE_API_KEY', testApiKey('live'));
			vi.mocked(fetch).mockResolvedValue(
				new Response(
					JSON.stringify({ error: 'INTERNAL_ERROR', detail: 'Database unavailable' }),
					{ status: 500, headers: { 'Content-Type': 'application/json' } }
				)
			);
			await whoami();
			expect(process.exitCode).toBe(ExitCode.NETWORK_OR_API_ERROR);
			expect(errors).toEqual(['Database unavailable']);
			expect(logs).toEqual([]);
		});
	});
});
