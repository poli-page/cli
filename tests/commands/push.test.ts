import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../../src/commands/init.js';
import {
	executePush,
	PUSH_MESSAGE_MAX_LENGTH,
} from '../../src/commands/push.js';
import { writeCredentials } from '../../src/credentials.js';
import { writeManifest, readManifest } from '../../src/manifest.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';
import type { ApiClient, VersionInfo, PushVersionBody } from '../../src/api-client.js';

function sandboxVersion(over: Partial<VersionInfo> = {}): VersionInfo {
	return {
		id: 'ver_1',
		version: '1.0.0',
		major: 1,
		minor: 0,
		patch: 0,
		state: 'SANDBOX',
		bumpType: 'patch',
		createdAt: '2026-05-06T00:00:00.000Z',
		...over,
	};
}

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
	return {
		signIn: async () => ({ user: { id: 'u', name: 'X', email: 'x@x' }, session: 's' }),
		signUp: async () => ({ user: { id: 'u', name: 'X', email: 'x@x' }, session: 's' }),
		deviceRequest: async () => ({
			deviceCode: 'd',
			userCode: 'c',
			verificationUrl: '',
			expiresIn: 0,
			interval: 0.01,
		}),
		devicePoll: async () => ({ status: 'authorization_pending' as const }),
		getOrganizations: async () => [],
		listProjects: async () => [],
		createProject: async () => ({ id: 'p' }),
		updateProject: vi.fn(async () => {}),
		createApiKey: async () => ({
			key: 'k',
			info: { id: '1', name: 'n', environment: 'test' },
		}),
		render: async () => { throw new Error('not implemented in stub'); },
		pushVersion: vi.fn(async () => sandboxVersion()),
		listVersions: async () => [],
		downloadVersion: async () => ({ manifest: {}, templates: [] }),
		getMe: async () => ({
			auth: { mode: 'session', keyType: 'session', environment: null },
			user: null,
			key: null,
			org: null,
		}),
		...overrides,
	};
}

describe('poli push', () => {
	let tempDir: string;
	let projectDir: string;
	let fakeHome: string;

	async function setupLinked() {
		await writeCredentials(
			{
				session: 'session-token',
				user: { id: 'u1', name: 'X', email: 'x@x' },
				orgs: { acme: {} },
			},
			fakeHome
		);
		const manifest = await readManifest(projectDir);
		manifest.cloud = {
			orgSlug: 'acme',
			orgId: 'org_uuid',
			projectSlug: 'test-project',
			projectId: 'proj_1',
		};
		await writeManifest(projectDir, manifest);
	}

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-push-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-push-home-'));
		projectDir = await executeInit('test-project', { cwd: tempDir });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	describe('bump types', () => {
		it('defaults to patch when no bump is specified', async () => {
			await setupLinked();
			const client = createMockApiClient();
			await executePush({ cwd: projectDir, apiClient: client, homeDir: fakeHome });
			const args = (client.pushVersion as ReturnType<typeof vi.fn>).mock.calls[0];
			const body = args[3] as PushVersionBody;
			expect(body.bumpType).toBe('patch');
		});

		it('passes bumpType=patch', async () => {
			await setupLinked();
			const client = createMockApiClient();
			await executePush({
				cwd: projectDir,
				bump: 'patch',
				apiClient: client,
				homeDir: fakeHome,
			});
			const body = (client.pushVersion as ReturnType<typeof vi.fn>).mock.calls[0][3] as PushVersionBody;
			expect(body.bumpType).toBe('patch');
		});

		it('passes bumpType=minor', async () => {
			await setupLinked();
			const client = createMockApiClient();
			await executePush({
				cwd: projectDir,
				bump: 'minor',
				apiClient: client,
				homeDir: fakeHome,
			});
			const body = (client.pushVersion as ReturnType<typeof vi.fn>).mock.calls[0][3] as PushVersionBody;
			expect(body.bumpType).toBe('minor');
		});

		it('passes bumpType=major', async () => {
			await setupLinked();
			const client = createMockApiClient();
			await executePush({
				cwd: projectDir,
				bump: 'major',
				apiClient: client,
				homeDir: fakeHome,
			});
			const body = (client.pushVersion as ReturnType<typeof vi.fn>).mock.calls[0][3] as PushVersionBody;
			expect(body.bumpType).toBe('major');
		});
	});

	describe('message', () => {
		it('includes the message in the request body', async () => {
			await setupLinked();
			const client = createMockApiClient();
			await executePush({
				cwd: projectDir,
				message: 'Fix invoice alignment',
				apiClient: client,
				homeDir: fakeHome,
			});
			const body = (client.pushVersion as ReturnType<typeof vi.fn>).mock.calls[0][3] as PushVersionBody;
			expect(body.message).toBe('Fix invoice alignment');
		});

		it('omits the message field when not provided', async () => {
			await setupLinked();
			const client = createMockApiClient();
			await executePush({ cwd: projectDir, apiClient: client, homeDir: fakeHome });
			const body = (client.pushVersion as ReturnType<typeof vi.fn>).mock.calls[0][3] as PushVersionBody;
			expect('message' in body).toBe(false);
		});

		it('rejects locally a message longer than 500 chars', async () => {
			await setupLinked();
			const longMessage = 'x'.repeat(PUSH_MESSAGE_MAX_LENGTH + 1);
			await expect(
				executePush({
					cwd: projectDir,
					message: longMessage,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/too long|500/);
		});

		it('accepts a message at exactly 500 chars', async () => {
			await setupLinked();
			const exactMessage = 'x'.repeat(PUSH_MESSAGE_MAX_LENGTH);
			await expect(
				executePush({
					cwd: projectDir,
					message: exactMessage,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).resolves.toBeDefined();
		});
	});

	describe('preconditions', () => {
		it('throws when project is not linked', async () => {
			await writeCredentials(
				{ session: 's', user: { id: 'u', name: 'X', email: 'x@x' }, orgs: {} },
				fakeHome
			);
			await expect(
				executePush({
					cwd: projectDir,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/not linked/i);
		});

		it('throws when not logged in', async () => {
			const m = await readManifest(projectDir);
			m.cloud = {
				orgSlug: 'acme',
				orgId: 'org_uuid',
				projectSlug: 'test-project',
				projectId: 'proj_1',
			};
			await writeManifest(projectDir, m);
			await expect(
				executePush({
					cwd: projectDir,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/Not logged in/i);
		});

		it('throws when not in a Poli Page project', async () => {
			await writeCredentials(
				{ session: 's', user: { id: 'u', name: 'X', email: 'x@x' }, orgs: {} },
				fakeHome
			);
			await expect(
				executePush({
					cwd: join(tempDir, 'nowhere'),
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/poli-page\.json/i);
		});
	});

	describe('side effects', () => {
		it('updates manifest.project.version with the returned version', async () => {
			await setupLinked();
			const client = createMockApiClient({
				pushVersion: vi.fn(async () =>
					sandboxVersion({ version: '2.1.0', major: 2, minor: 1, patch: 0 })
				),
			});
			await executePush({ cwd: projectDir, apiClient: client, homeDir: fakeHome });
			const manifest = await readManifest(projectDir);
			expect(manifest.project.version).toBe('2.1.0');
		});

		it('syncs the local draft (calls updateProject) before pushing', async () => {
			await setupLinked();
			const callOrder: string[] = [];
			const client = createMockApiClient({
				updateProject: vi.fn(async () => {
					callOrder.push('updateProject');
				}),
				pushVersion: vi.fn(async () => {
					callOrder.push('pushVersion');
					return sandboxVersion();
				}),
			});
			await executePush({ cwd: projectDir, apiClient: client, homeDir: fakeHome });
			expect(callOrder).toEqual(['updateProject', 'pushVersion']);
		});

		it('includes font binaries in the sync payload', async () => {
			await setupLinked();
			const fontsDir = join(projectDir, 'assets', 'fonts');
			await mkdir(fontsDir, { recursive: true });
			await writeFile(
				join(fontsDir, 'inter-400.woff2'),
				Buffer.from([0x77, 0x4f, 0x46, 0x32])
			);
			const m = await readManifest(projectDir);
			m.fonts = [{ family: 'Inter', src: 'fonts/inter-400.woff2', weight: 400 }];
			await writeManifest(projectDir, m);

			const client = createMockApiClient();
			await executePush({ cwd: projectDir, apiClient: client, homeDir: fakeHome });

			const updateCall = (client.updateProject as ReturnType<typeof vi.fn>).mock.calls[0];
			const payload = updateCall[3] as Record<string, unknown>;
			const images = payload.images as Array<{ path: string; data: string }>;
			expect(images?.find((i) => i.path === 'fonts/inter-400.woff2')).toBeDefined();
		});
	});
});
