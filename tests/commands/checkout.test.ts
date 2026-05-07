import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../../src/commands/init.js';
import { executeCheckout } from '../../src/commands/checkout.js';
import { writeCredentials } from '../../src/credentials.js';
import { writeManifest, readManifest } from '../../src/manifest.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';
import type { ApiClient, ProjectBundle } from '../../src/api-client.js';

const FULL_BUNDLE: ProjectBundle = {
	version: '1.2.3',
	manifest: {
		project: { name: 'test-project', version: '1.2.3' },
		fonts: [
			{ family: 'Inter', src: 'fonts/inter-400.woff2', weight: 400 },
		],
		templates: [
			{ name: 'invoice', template: 'invoice.html', mock: 'invoice.json' },
		],
	},
	templates: [
		{ path: 'templates/invoice/invoice.html', content: '<div>Invoice 1.2.3</div>' },
		{ path: 'templates/invoice/invoice.json', content: '{"v":"1.2.3"}' },
	],
	images: [
		{ path: 'logo.svg', data: Buffer.from('<svg/>').toString('base64') },
	],
	tailwindCss: '@import "tailwindcss";\n@theme { --color-x: #fff; }',
};

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
	return {
		signIn: async () => ({
			user: { id: 'u1', name: 'X', email: 'x@x' },
			session: 's',
		}),
		signUp: async () => ({
			user: { id: 'u1', name: 'X', email: 'x@x' },
			session: 's',
		}),
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
		updateProject: async () => {},
		createApiKey: async () => ({
			key: 'k',
			info: { id: '1', name: 'n', environment: 'test' },
		}),
		render: async () => { throw new Error('not implemented in stub'); },
		pushVersion: async () => ({
			id: 'v',
			version: '1.0.0',
			major: 1,
			minor: 0,
			patch: 0,
			createdAt: '',
		}),
		listVersions: async () => [],
		downloadVersion: async () => FULL_BUNDLE,
		getMe: async () => ({
			auth: { mode: 'session', keyType: 'session', environment: null },
			user: null,
			key: null,
			org: null,
		}),
		...overrides,
	};
}

describe('poli checkout', () => {
	let tempDir: string;
	let projectDir: string;
	let fakeHome: string;

	async function setupLinked() {
		await writeCredentials(
			{
				session: 'session-token',
				user: { id: 'u1', name: 'X', email: 'x@test.com' },
				orgs: { acme: {} },
			},
			fakeHome
		);
		const manifest = await readManifest(projectDir);
		manifest.cloud = {
			orgSlug: 'acme',
			orgId: 'org_uuid_acme',
			projectSlug: 'test-project',
			projectId: 'proj_1',
		};
		await writeManifest(projectDir, manifest);
	}

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-checkout-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-co-home-'));
		projectDir = await executeInit('test-project', { cwd: tempDir });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	describe('version validation', () => {
		it('rejects "latest" with a friendly message', async () => {
			await setupLinked();
			await expect(
				executeCheckout({
					cwd: projectDir,
					version: 'latest',
					yes: true,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/latest.*retired/i);
		});

		it('rejects partial semver "1.0"', async () => {
			await setupLinked();
			await expect(
				executeCheckout({
					cwd: projectDir,
					version: '1.0',
					yes: true,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/exact semver|X\.Y\.Z/i);
		});

		it('rejects partial semver "1"', async () => {
			await setupLinked();
			await expect(
				executeCheckout({
					cwd: projectDir,
					version: '1',
					yes: true,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/exact semver|X\.Y\.Z/i);
		});

		it('rejects unknown formats', async () => {
			await setupLinked();
			await expect(
				executeCheckout({
					cwd: projectDir,
					version: 'banana',
					yes: true,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/Invalid version/i);
		});

		it('accepts an exact semver "1.2.3"', async () => {
			await setupLinked();
			await expect(
				executeCheckout({
					cwd: projectDir,
					version: '1.2.3',
					yes: true,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).resolves.toBeUndefined();
		});
	});

	describe('preconditions', () => {
		it('throws when not in a Poli Page project', async () => {
			await expect(
				executeCheckout({
					cwd: join(tempDir, 'nowhere'),
					version: '1.2.3',
					yes: true,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/poli-page\.json/i);
		});

		it('throws when project is not linked (no cloud section)', async () => {
			await writeCredentials(
				{
					session: 's',
					user: { id: 'u', name: 'X', email: 'x@x' },
					orgs: {},
				},
				fakeHome
			);
			await expect(
				executeCheckout({
					cwd: projectDir,
					version: '1.2.3',
					yes: true,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/not linked/i);
		});

		it('throws when not logged in', async () => {
			const m = await readManifest(projectDir);
			m.cloud = {
				orgSlug: 'acme',
				orgId: 'org_uuid_acme',
				projectSlug: 'test-project',
				projectId: 'proj_1',
			};
			await writeManifest(projectDir, m);

			await expect(
				executeCheckout({
					cwd: projectDir,
					version: '1.2.3',
					yes: true,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/Not logged in/i);
		});
	});

	describe('happy path', () => {
		it('downloads and writes template files, images, tailwind.css, and merges manifest preserving cloud', async () => {
			await setupLinked();

			let receivedArgs: unknown[] = [];
			const client = createMockApiClient({
				downloadVersion: async (...args) => {
					receivedArgs = args;
					return FULL_BUNDLE;
				},
			});

			await executeCheckout({
				cwd: projectDir,
				version: '1.2.3',
				yes: true,
				apiClient: client,
				homeDir: fakeHome,
			});

			// Correct arguments passed to downloadVersion
			expect(receivedArgs).toEqual([
				'session-token',
				'org_uuid_acme',
				'proj_1',
				'1.2.3',
			]);

			// Template files written
			const html = await readFile(
				join(projectDir, 'templates', 'invoice', 'invoice.html'),
				'utf-8'
			);
			expect(html).toBe('<div>Invoice 1.2.3</div>');

			// Image binary written under assets/images/
			const img = await readFile(join(projectDir, 'assets', 'images', 'logo.svg'));
			expect(img.toString()).toBe('<svg/>');

			// tailwind.css overwritten
			const tw = await readFile(join(projectDir, 'tailwind.css'), 'utf-8');
			expect(tw).toContain('--color-x');

			// Manifest merged AND cloud section preserved + track derived
			// from the checked-out version.
			const manifest = await readManifest(projectDir);
			expect(manifest.project.version).toBe('1.2.3');
			expect(manifest.cloud).toEqual({
				orgSlug: 'acme',
				orgId: 'org_uuid_acme',
				projectSlug: 'test-project',
				projectId: 'proj_1',
				track: '1.2',
			});
			expect(manifest.templates?.[0].name).toBe('invoice');
			expect(manifest.fonts?.[0].family).toBe('Inter');
		});

		it('updates cloud.track when checking out a different track', async () => {
			await setupLinked();
			// Pre-set an existing track; checkout should overwrite it.
			const m = await readManifest(projectDir);
			m.cloud!.track = '1.0';
			await writeManifest(projectDir, m);

			await executeCheckout({
				cwd: projectDir,
				version: '2.5.7',
				yes: true,
				apiClient: createMockApiClient({
					downloadVersion: async () => FULL_BUNDLE,
				}),
				homeDir: fakeHome,
			});

			const manifest = await readManifest(projectDir);
			expect(manifest.cloud?.track).toBe('2.5');
		});
	});

	describe('confirmation', () => {
		it('aborts when confirmOverwrite returns false', async () => {
			await setupLinked();
			await expect(
				executeCheckout({
					cwd: projectDir,
					version: '1.2.3',
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
					confirmOverwrite: async () => false,
				})
			).rejects.toThrow(/cancelled/i);
		});

		it('proceeds when confirmOverwrite returns true', async () => {
			await setupLinked();
			let downloadCalled = false;
			const client = createMockApiClient({
				downloadVersion: async () => {
					downloadCalled = true;
					return FULL_BUNDLE;
				},
			});
			await executeCheckout({
				cwd: projectDir,
				version: '1.2.3',
				apiClient: client,
				homeDir: fakeHome,
				confirmOverwrite: async () => true,
			});
			expect(downloadCalled).toBe(true);
		});
	});
});
