import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../../src/commands/init.js';
import { executeLink, executeUnlink } from '../../src/commands/link.js';
import { writeCredentials } from '../../src/credentials.js';
import { isLinkConfirmed, recordLink } from '../../src/cloud-link.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';
import { errorToExitCode } from '../../src/exit-codes.js';
import type { ApiClient } from '../../src/api-client.js';
import { createFakeApiClient } from '../helpers/fake-api-client.js';
import { plantImagesOverTotalLimit } from '../helpers/over-limit-project.js';

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
	return createFakeApiClient({
		getOrganizations: async () => [
			{ id: '0e89d99e-1516-4b48-baa1-f49e660ad1c1', name: 'Acme Corp', slug: 'acme-corp' },
			{ id: 'a2c4e6f8-1b3d-4f5a-8c7e-9d0b2a4c6e81', name: 'Beta Inc', slug: 'beta-inc' },
		],
		listProjects: async () => [],
		createProject: async () => ({ id: '6fa459ea-ee8a-4ca4-894e-db77e160355e' }),
		...overrides,
	});
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
		it('refuses a project over the file limits before any request', async () => {
			await plantImagesOverTotalLimit(projectDir);

			const err = await executeLink({
				cwd: projectDir,
				orgSlug: 'acme-corp',
				apiClient: createFakeApiClient({}),
				homeDir: fakeHome,
			}).catch((e) => e);

			expect(err.message).toMatch(/add up to more than 5\.0 MiB/);
			expect(errorToExitCode(err)).toBe(2);
			const manifest = JSON.parse(await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8'));
			expect(manifest.cloud).toBeUndefined();
		});

		it('writes the full cloud section to poli-page.json', async () => {
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
				orgId: '0e89d99e-1516-4b48-baa1-f49e660ad1c1',
				projectSlug: 'test-project',
				projectId: '6fa459ea-ee8a-4ca4-894e-db77e160355e',
			});
		});

		it('records the link as confirmed, so dev and watch sync with no prompt', async () => {
			await executeLink({
				cwd: projectDir,
				orgSlug: 'acme-corp',
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			expect(
				await isLinkConfirmed(projectDir, '6fa459ea-ee8a-4ca4-894e-db77e160355e', fakeHome)
			).toBe(true);
			const linksPath = join(fakeHome, '.polipage', 'links.json');
			expect((await stat(linksPath)).mode & 0o777).toBe(0o600);
		});

		it('does not cache an API key in credentials (CLI uses session auth)', async () => {
			await executeLink({
				cwd: projectDir,
				orgSlug: 'acme-corp',
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			const { readCredentials } = await import('../../src/credentials.js');
			const creds = await readCredentials(fakeHome);
			expect(creds?.orgs['acme-corp']?.testKey).toBe('pp_test_abc');
			// the pre-existing test key stayed; no NEW key was minted
		});

		it('sends the full project payload (manifest + templates) to createProject', async () => {
			let receivedPayload: Record<string, unknown> | undefined;
			const client = createMockApiClient({
				createProject: async (_session, _orgId, payload) => {
					receivedPayload = payload as Record<string, unknown>;
					return { id: '6fa459ea-ee8a-4ca4-894e-db77e160355e' };
				},
			});

			await executeLink({
				cwd: projectDir,
				orgSlug: 'acme-corp',
				apiClient: client,
				homeDir: fakeHome,
			});

			expect(receivedPayload).toBeDefined();
			expect(receivedPayload).toHaveProperty('manifest');
			expect(receivedPayload).toHaveProperty('templates');
			// `name` and `slug` (the previous shape) must not be at the top level —
			// they belong inside `manifest.project`.
			expect(receivedPayload).not.toHaveProperty('name');
			expect(receivedPayload).not.toHaveProperty('slug');

			const manifest = (receivedPayload as { manifest: { project: { name: string } } })
				.manifest;
			expect(manifest.project.name).toBe('test-project');
		});

		describe('when the organization already has a project with the same slug', () => {
			let createCalled: boolean;
			let client: ApiClient;

			beforeEach(() => {
				createCalled = false;
				client = createMockApiClient({
					listProjects: async () => [
						{ id: 'existing_proj_id', name: 'Test Project', slug: 'test-project' },
					],
					createProject: async () => {
						createCalled = true;
						return { id: 'NEW_id_should_not_be_used' };
					},
				});
			});

			async function readCloud() {
				const manifest = JSON.parse(
					await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
				);
				return manifest.cloud;
			}

			it('links to it with existing: true (re-link)', async () => {
				await executeLink({
					cwd: projectDir,
					orgSlug: 'acme-corp',
					apiClient: client,
					homeDir: fakeHome,
					existing: true,
				});

				expect(createCalled).toBe(false);
				expect((await readCloud()).projectId).toBe('existing_proj_id');
				expect(await isLinkConfirmed(projectDir, 'existing_proj_id', fakeHome)).toBe(true);
			});

			it('refuses with exit 2 and writes nothing when nobody can be asked', async () => {
				const error = await executeLink({
					cwd: projectDir,
					orgSlug: 'acme-corp',
					apiClient: client,
					homeDir: fakeHome,
				}).catch((e: unknown) => e);

				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toMatch(/--existing/);
				expect(errorToExitCode(error)).toBe(2);
				expect(createCalled).toBe(false);
				expect(await readCloud()).toBeUndefined();
				expect(await isLinkConfirmed(projectDir, 'existing_proj_id', fakeHome)).toBe(false);
			});

			it('names a server project and organization with control characters on one line', async () => {
				const error = await executeLink({
					cwd: projectDir,
					orgSlug: 'acme\u0007corp',
					apiClient: createMockApiClient({
						getOrganizations: async () => [
							{
								id: '0e89d99e-1516-4b48-baa1-f49e660ad1c1',
								name: 'Acme',
								slug: 'acme\u0007corp',
							},
						],
						listProjects: async () => [
							{
								id: 'existing_proj_id',
								name: 'Test\nProject\u001b[2J',
								slug: 'test-project',
							},
						],
					}),
					homeDir: fakeHome,
				}).catch((e: unknown) => e);

				expect((error as Error).message).toMatch(
					/^Organization "acme corp" already has a project "Test Project \[2J" \(test-project\)\. [^\p{Cc}]+$/u
				);
			});

			it('asks, naming the project and organization, and links on yes', async () => {
				const confirmExisting = vi.fn(async () => true);
				await executeLink({
					cwd: projectDir,
					orgSlug: 'acme-corp',
					apiClient: client,
					homeDir: fakeHome,
					confirmExisting,
				});

				expect(confirmExisting).toHaveBeenCalledWith({
					org: {
						id: '0e89d99e-1516-4b48-baa1-f49e660ad1c1',
						name: 'Acme Corp',
						slug: 'acme-corp',
					},
					project: { id: 'existing_proj_id', name: 'Test Project', slug: 'test-project' },
				});
				expect(createCalled).toBe(false);
				expect((await readCloud()).projectId).toBe('existing_proj_id');
			});

			it('leaves the folder unlinked on no', async () => {
				const error = await executeLink({
					cwd: projectDir,
					orgSlug: 'acme-corp',
					apiClient: client,
					homeDir: fakeHome,
					confirmExisting: async () => false,
				}).catch((e: unknown) => e);

				expect((error as Error).message).toMatch(/Link cancelled/);
				expect(errorToExitCode(error)).toBe(1);
				expect(createCalled).toBe(false);
				expect(await readCloud()).toBeUndefined();
				expect(await isLinkConfirmed(projectDir, 'existing_proj_id', fakeHome)).toBe(false);
			});

			it('does not ask with existing: true', async () => {
				const confirmExisting = vi.fn(async () => false);
				await executeLink({
					cwd: projectDir,
					orgSlug: 'acme-corp',
					apiClient: client,
					homeDir: fakeHome,
					existing: true,
					confirmExisting,
				});

				expect(confirmExisting).not.toHaveBeenCalled();
				expect((await readCloud()).projectId).toBe('existing_proj_id');
			});
		});

		it('does not ask when the project is new', async () => {
			const confirmExisting = vi.fn(async () => false);
			await executeLink({
				cwd: projectDir,
				orgSlug: 'acme-corp',
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
				confirmExisting,
			});

			expect(confirmExisting).not.toHaveBeenCalled();
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

		it('silently drops project.version and cloud.track from an old manifest', async () => {
			await writeFile(
				join(projectDir, MANIFEST_FILENAME),
				JSON.stringify({
					project: { name: 'test-project', version: '1.2.0' },
					cloud: {
						orgSlug: 'acme-corp',
						projectId: '6fa459ea-ee8a-4ca4-894e-db77e160355e',
						track: '1.2',
					},
				})
			);
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				await executeUnlink({ cwd: projectDir });
				expect(log).not.toHaveBeenCalled();
				expect(warn).not.toHaveBeenCalled();
				expect(error).not.toHaveBeenCalled();
			} finally {
				log.mockRestore();
				warn.mockRestore();
				error.mockRestore();
			}

			const manifest = JSON.parse(
				await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
			);
			expect(manifest).toEqual({ project: { name: 'test-project' } });
		});

		it('removes a cloud block whose ids are not UUIDs', async () => {
			await writeFile(
				join(projectDir, MANIFEST_FILENAME),
				JSON.stringify({
					project: { name: 'test-project' },
					cloud: { orgSlug: 'acme-corp', orgId: 'org_1', projectId: 'proj_1' },
				})
			);

			await executeUnlink({ cwd: projectDir, homeDir: fakeHome });

			const manifest = JSON.parse(
				await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
			);
			expect(manifest).toEqual({ project: { name: 'test-project' } });
		});

		it('still validates the rest of the manifest', async () => {
			await writeFile(
				join(projectDir, MANIFEST_FILENAME),
				JSON.stringify({
					project: {},
					cloud: { orgSlug: 'acme-corp', projectId: 'proj_1' },
				})
			);
			await expect(executeUnlink({ cwd: projectDir })).rejects.toThrow(/project\.name/);
		});

		it("forgets the folder's confirmed link, and only that folder's", async () => {
			const other = await mkdtemp(join(tmpdir(), 'poli-link-other-'));
			try {
				await executeLink({
					cwd: projectDir,
					orgSlug: 'acme-corp',
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				});
				await recordLink(other, 'proj_other', fakeHome);

				await executeUnlink({ cwd: projectDir, homeDir: fakeHome });

				expect(
					await isLinkConfirmed(
						projectDir,
						'6fa459ea-ee8a-4ca4-894e-db77e160355e',
						fakeHome
					)
				).toBe(false);
				expect(await isLinkConfirmed(other, 'proj_other', fakeHome)).toBe(true);
			} finally {
				await rm(other, { recursive: true, force: true });
			}
		});

		it('keeps the cloud block when the confirmed link cannot be forgotten, so unlink can be retried', async () => {
			await executeLink({
				cwd: projectDir,
				orgSlug: 'acme-corp',
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});
			const linksPath = join(fakeHome, '.polipage', 'links.json');
			// A directory in place of links.json makes forgetLink fail.
			await rm(linksPath);
			await mkdir(linksPath);

			await expect(executeUnlink({ cwd: projectDir, homeDir: fakeHome })).rejects.toThrow();

			const manifest = JSON.parse(
				await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
			);
			expect(manifest.cloud).toBeDefined();
		});

		it('should throw if not linked', async () => {
			await expect(executeUnlink({ cwd: projectDir })).rejects.toThrow(/not linked/);
		});

		it('should throw if no poli-page.json', async () => {
			await expect(executeUnlink({ cwd: tempDir + '/nonexistent' })).rejects.toThrow(
				/poli-page\.json/
			);
		});
	});
});
