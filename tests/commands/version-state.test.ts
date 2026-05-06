import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../../src/commands/init.js';
import {
	executePromote,
	executeUnpromote,
	executeUnpromotePreview,
	executeDeprecate,
	executeUndeprecate,
} from '../../src/commands/version-state.js';
import { writeCredentials } from '../../src/credentials.js';
import { writeManifest, readManifest } from '../../src/manifest.js';
import type {
	ApiClient,
	VersionInfo,
	UnpromotePreview,
} from '../../src/api-client.js';

function ver(state: VersionInfo['state'], v = '1.5.0'): VersionInfo {
	const [major, minor, patch] = v.split('.').map(Number);
	return {
		id: 'ver_x',
		version: v,
		major,
		minor,
		patch,
		state,
		createdAt: '2026-05-06T00:00:00Z',
	};
}

function preview(over: Partial<UnpromotePreview> = {}): UnpromotePreview {
	return {
		currentLatestLive: '1.5.0',
		newLatestLiveAfterUnpromote: '1.4.0',
		willHaveNoLive: false,
		recentLiveCalls: 12,
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
		getOrganizations: async () => [{ id: 'org_1', name: 'A', slug: 'acme' }],
		listProjects: async () => [],
		createProject: async () => ({ id: 'p' }),
		updateProject: async () => {},
		createApiKey: async () => ({
			key: 'k',
			info: { id: '1', name: 'n', environment: 'test' },
		}),
		renderPdf: async () => ({ pdf: Buffer.from(''), environment: 'sandbox' }),
		renderThumbnails: async () => [],
		pushVersion: async () => ver('SANDBOX'),
		listVersions: async () => [],
		downloadVersion: async () => ({ manifest: {}, templates: [] }),
		promoteVersion: vi.fn(async () => ver('LIVE')),
		unpromoteVersion: vi.fn(async () => ver('SANDBOX')),
		unpromotePreview: vi.fn(async () => preview()),
		deprecateVersion: vi.fn(async () => ver('DEPRECATED', '1.4.0')),
		undeprecateVersion: vi.fn(async () => ver('SANDBOX', '1.4.0')),
		getMe: async () => ({
			auth: { mode: 'session', keyType: 'session', environment: null },
			user: null,
			key: null,
			org: null,
		}),
		...overrides,
	};
}

describe('version state-machine commands', () => {
	let tempDir: string;
	let projectDir: string;
	let fakeHome: string;

	async function setupLinked() {
		await writeCredentials(
			{
				session: 'session-token',
				user: { id: 'u', name: 'X', email: 'x@x' },
				orgs: { acme: {} },
			},
			fakeHome
		);
		const m = await readManifest(projectDir);
		m.cloud = {
			orgSlug: 'acme',
			orgId: 'org_1',
			projectSlug: 'test-project',
			projectId: 'proj_1',
		};
		await writeManifest(projectDir, m);
	}

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-vs-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-vs-home-'));
		projectDir = await executeInit('test-project', { cwd: tempDir });
		await setupLinked();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	describe('local version validation (shared by all commands)', () => {
		const cmds = [
			['promote', executePromote],
			['unpromote', executeUnpromote],
			['unpromote-preview', executeUnpromotePreview],
			['deprecate', executeDeprecate],
			['un-deprecate', executeUndeprecate],
		] as const;

		for (const [name, fn] of cmds) {
			it(`${name}: rejects "latest"`, async () => {
				await expect(
					fn('latest', {
						cwd: projectDir,
						apiClient: createMockApiClient(),
						homeDir: fakeHome,
						yes: true,
					})
				).rejects.toThrow(/latest.*retired/i);
			});

			it(`${name}: rejects partial semver "1.0"`, async () => {
				await expect(
					fn('1.0', {
						cwd: projectDir,
						apiClient: createMockApiClient(),
						homeDir: fakeHome,
						yes: true,
					})
				).rejects.toThrow(/exact semver|X\.Y\.Z/i);
			});

			it(`${name}: rejects unknown formats`, async () => {
				await expect(
					fn('banana', {
						cwd: projectDir,
						apiClient: createMockApiClient(),
						homeDir: fakeHome,
						yes: true,
					})
				).rejects.toThrow(/Invalid version/i);
			});
		}
	});

	describe('executePromote', () => {
		it('calls promoteVersion with the right args on a valid semver', async () => {
			const client = createMockApiClient();
			const result = await executePromote('1.5.0', {
				cwd: projectDir,
				apiClient: client,
				homeDir: fakeHome,
				yes: true,
			});
			expect(result.state).toBe('LIVE');
			expect(
				(client.promoteVersion as ReturnType<typeof vi.fn>).mock.calls[0]
			).toEqual(['session-token', 'org_1', 'proj_1', '1.5.0']);
		});

		it('aborts when confirmFn returns false', async () => {
			await expect(
				executePromote('1.5.0', {
					cwd: projectDir,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
					confirmFn: async () => false,
				})
			).rejects.toThrow(/cancelled/i);
		});

		it('proceeds when confirmFn returns true', async () => {
			const client = createMockApiClient();
			await executePromote('1.5.0', {
				cwd: projectDir,
				apiClient: client,
				homeDir: fakeHome,
				confirmFn: async () => true,
			});
			expect(client.promoteVersion).toHaveBeenCalled();
		});
	});

	describe('executeUnpromote', () => {
		it('calls preview before unpromote and returns both', async () => {
			const client = createMockApiClient();
			const order: string[] = [];
			const wrapped = createMockApiClient({
				unpromotePreview: vi.fn(async (...args) => {
					order.push('preview');
					return (client.unpromotePreview as ReturnType<typeof vi.fn>)(...args);
				}),
				unpromoteVersion: vi.fn(async (...args) => {
					order.push('unpromote');
					return (client.unpromoteVersion as ReturnType<typeof vi.fn>)(...args);
				}),
			});

			const out = await executeUnpromote('1.5.0', {
				cwd: projectDir,
				apiClient: wrapped,
				homeDir: fakeHome,
				yes: true,
			});

			expect(order).toEqual(['preview', 'unpromote']);
			expect(out.preview.currentLatestLive).toBe('1.5.0');
			expect(out.result.state).toBe('SANDBOX');
		});

		it('forwards force=true to the API body when set', async () => {
			const client = createMockApiClient();
			await executeUnpromote('1.5.0', {
				cwd: projectDir,
				apiClient: client,
				homeDir: fakeHome,
				yes: true,
				force: true,
			});
			const args = (client.unpromoteVersion as ReturnType<typeof vi.fn>).mock.calls[0];
			expect(args[4]).toEqual({ force: true });
		});

		it('passes the preview to confirmFn for the warning UX', async () => {
			let received: UnpromotePreview | undefined;
			const client = createMockApiClient({
				unpromotePreview: vi.fn(async () => preview({ willHaveNoLive: true })),
			});
			await expect(
				executeUnpromote('1.5.0', {
					cwd: projectDir,
					apiClient: client,
					homeDir: fakeHome,
					confirmFn: async (info) => {
						received = info.preview;
						return true;
					},
				})
			).resolves.toBeDefined();
			expect(received?.willHaveNoLive).toBe(true);
		});

		it('aborts when confirmFn returns false (does not call unpromote)', async () => {
			const client = createMockApiClient();
			await expect(
				executeUnpromote('1.5.0', {
					cwd: projectDir,
					apiClient: client,
					homeDir: fakeHome,
					confirmFn: async () => false,
				})
			).rejects.toThrow(/cancelled/i);
			expect(client.unpromoteVersion).not.toHaveBeenCalled();
		});
	});

	describe('executeUnpromotePreview', () => {
		it('returns the preview without unpromoting', async () => {
			const client = createMockApiClient();
			const out = await executeUnpromotePreview('1.5.0', {
				cwd: projectDir,
				apiClient: client,
				homeDir: fakeHome,
			});
			expect(out.recentLiveCalls).toBe(12);
			expect(client.unpromoteVersion).not.toHaveBeenCalled();
		});
	});

	describe('executeDeprecate / executeUndeprecate', () => {
		it('deprecate calls deprecateVersion', async () => {
			const client = createMockApiClient();
			const r = await executeDeprecate('1.4.0', {
				cwd: projectDir,
				apiClient: client,
				homeDir: fakeHome,
				yes: true,
			});
			expect(r.state).toBe('DEPRECATED');
			expect(
				(client.deprecateVersion as ReturnType<typeof vi.fn>).mock.calls[0]
			).toEqual(['session-token', 'org_1', 'proj_1', '1.4.0']);
		});

		it('un-deprecate calls undeprecateVersion', async () => {
			const client = createMockApiClient();
			const r = await executeUndeprecate('1.4.0', {
				cwd: projectDir,
				apiClient: client,
				homeDir: fakeHome,
				yes: true,
			});
			expect(r.state).toBe('SANDBOX');
			expect(
				(client.undeprecateVersion as ReturnType<typeof vi.fn>).mock.calls[0]
			).toEqual(['session-token', 'org_1', 'proj_1', '1.4.0']);
		});
	});
});
