import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../../src/commands/init.js';
import { setupTemplate } from '../helpers/setup-template.js';
import { executeRender } from '../../src/commands/render.js';
import { writeCredentials } from '../../src/credentials.js';
import { writeManifest, readManifest } from '../../src/manifest.js';
import type { ApiClient, RenderPdfResult } from '../../src/api-client.js';

const FAKE_PDF = Buffer.from('%PDF-1.4 fake pdf content');

interface RenderCall {
	authorization: string;
	orgIdHeader: string | undefined;
	payload: Record<string, unknown>;
}

function createMockApiClient(
	options: {
		render?: (call: RenderCall) => RenderPdfResult | Promise<RenderPdfResult>;
		calls?: RenderCall[];
	} = {}
): ApiClient {
	const defaultRender = (): RenderPdfResult => ({
		pdf: FAKE_PDF,
		environment: 'sandbox',
	});
	return {
		signIn: async () => ({
			user: { id: 'user_1', name: 'Test', email: 'test@test.com' },
			session: 'mock-session',
		}),
		signUp: async () => ({
			user: { id: 'user_1', name: 'Test', email: 'test@test.com' },
			session: 'mock-session',
		}),
		getOrganizations: async () => [{ id: 'org_1', name: 'Acme', slug: 'acme' }],
		listProjects: async () => [],
		createProject: async () => ({ id: 'proj_1' }),
		createApiKey: async () => ({
			key: 'pp_test_mock',
			info: { id: 'key_1', name: 'CLI (test)', environment: 'test' },
		}),
		renderPdf: async (authorization, orgIdHeader, payload) => {
			const call: RenderCall = { authorization, orgIdHeader, payload };
			options.calls?.push(call);
			return options.render ? options.render(call) : defaultRender();
		},
		deviceRequest: async () => ({
			deviceCode: 'dc',
			userCode: 'uc',
			verificationUrl: 'http://localhost',
			expiresIn: 300,
			interval: 5,
		}),
		devicePoll: async () => ({ status: 'authorization_pending' as const }),
		updateProject: async () => {},
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
	};
}

describe('poli render', () => {
	let tempDir: string;
	let projectDir: string;
	let fakeHome: string;
	let savedEnvKey: string | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-render-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-home-'));
		projectDir = await executeInit('test-project', { cwd: tempDir });
		await setupTemplate(projectDir, 'invoice');

		const manifest = await readManifest(projectDir);
		manifest.cloud = {
			orgSlug: 'acme',
			orgId: 'org_uuid_acme',
			projectSlug: 'test-project',
			projectId: 'proj_1',
		};
		await writeManifest(projectDir, manifest);

		await writeCredentials(
			{
				session: 'mock-session-token',
				user: { id: 'user_1', name: 'Test', email: 'test@test.com' },
				orgs: { acme: {} },
			},
			fakeHome
		);

		savedEnvKey = process.env.POLI_PAGE_API_KEY;
		delete process.env.POLI_PAGE_API_KEY;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
		if (savedEnvKey === undefined) {
			delete process.env.POLI_PAGE_API_KEY;
		} else {
			process.env.POLI_PAGE_API_KEY = savedEnvKey;
		}
	});

	describe('session mode', () => {
		it('passes Authorization with session token and X-Poli-Org-Id from manifest', async () => {
			const calls: RenderCall[] = [];
			const client = createMockApiClient({ calls });

			await executeRender('invoice', {
				cwd: projectDir,
				apiClient: client,
				homeDir: fakeHome,
			});

			expect(calls).toHaveLength(1);
			expect(calls[0].authorization).toBe('Bearer mock-session-token');
			expect(calls[0].orgIdHeader).toBe('org_uuid_acme');
		});

		it('throws a friendly error when manifest has no cloud.orgId', async () => {
			const manifest = await readManifest(projectDir);
			delete manifest.cloud!.orgId;
			await writeManifest(projectDir, manifest);

			await expect(
				executeRender('invoice', {
					cwd: projectDir,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/orgId|isn't linked/i);
		});
	});

	describe('api-key mode (env var)', () => {
		it('uses POLI_PAGE_API_KEY when no credentials are present', async () => {
			const emptyHome = await mkdtemp(join(tmpdir(), 'poli-empty-'));
			process.env.POLI_PAGE_API_KEY = 'pp_test_envkey';

			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient({ calls }),
				homeDir: emptyHome,
			});

			expect(calls[0].authorization).toBe('Bearer pp_test_envkey');
			expect(calls[0].orgIdHeader).toBeUndefined();
			await rm(emptyHome, { recursive: true, force: true });
		});

		it('does not require cloud.orgId when authenticated by API key', async () => {
			const emptyHome = await mkdtemp(join(tmpdir(), 'poli-empty-'));
			process.env.POLI_PAGE_API_KEY = 'pp_test_envkey';

			const manifest = await readManifest(projectDir);
			delete manifest.cloud!.orgId;
			await writeManifest(projectDir, manifest);

			await expect(
				executeRender('invoice', {
					cwd: projectDir,
					apiClient: createMockApiClient(),
					homeDir: emptyHome,
				})
			).resolves.toBeDefined();
			await rm(emptyHome, { recursive: true, force: true });
		});
	});

	describe('--version validation', () => {
		it('defaults to "draft" when not specified', async () => {
			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
			});
			expect(calls[0].payload.version).toBe('draft');
		});

		it('passes through an explicit "draft" value', async () => {
			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				version: 'draft',
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
			});
			expect(calls[0].payload.version).toBe('draft');
		});

		it('passes through an exact semver "1.2.3"', async () => {
			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				version: '1.2.3',
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
			});
			expect(calls[0].payload.version).toBe('1.2.3');
		});

		it('rejects "latest" locally with a friendly message', async () => {
			await expect(
				executeRender('invoice', {
					cwd: projectDir,
					version: 'latest',
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/latest.*retired/i);
		});

		it('rejects partial semver "1.0" locally', async () => {
			await expect(
				executeRender('invoice', {
					cwd: projectDir,
					version: '1.0',
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/exact semver|X\.Y\.Z/i);
		});

		it('rejects partial semver "1" locally', async () => {
			await expect(
				executeRender('invoice', {
					cwd: projectDir,
					version: '1',
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/exact semver|X\.Y\.Z/i);
		});

		it('rejects unknown formats locally', async () => {
			await expect(
				executeRender('invoice', {
					cwd: projectDir,
					version: 'banana',
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/Invalid version/i);
		});
	});

	describe('output and data', () => {
		it('writes the PDF to output/<name>.pdf by default', async () => {
			const result = await executeRender('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			expect(result.outputPath).toContain(join('output', 'invoice.pdf'));
			const stats = await stat(result.outputPath);
			expect(stats.isFile()).toBe(true);
			const content = await readFile(result.outputPath);
			expect(content).toEqual(FAKE_PDF);
		});

		it('writes to a custom -o path', async () => {
			const customPath = join(tempDir, 'custom-output.pdf');
			const result = await executeRender('invoice', {
				cwd: projectDir,
				output: customPath,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});
			expect(result.outputPath).toBe(customPath);
		});

		it('reads custom data via -d <file> (flat shape)', async () => {
			const dataPath = join(tempDir, 'data.json');
			await writeFile(
				dataPath,
				JSON.stringify({ title: 'Custom', amount: 42 }),
				'utf-8'
			);

			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				data: dataPath,
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
			});

			expect(calls[0].payload.data).toEqual({ title: 'Custom', amount: 42 });
		});

		it('unwraps the wrapped { locale, data: {...} } shape from --data (matches mock convention)', async () => {
			const dataPath = join(tempDir, 'data.json');
			await writeFile(
				dataPath,
				JSON.stringify({
					locale: 'fr',
					data: { title: 'Mes nouvelles données' },
				}),
				'utf-8'
			);

			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				data: dataPath,
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
			});

			expect(calls[0].payload.data).toEqual({ title: 'Mes nouvelles données' });
		});

		it('forwards the mock locale to the API when present', async () => {
			// The default invoice mock written by setupTemplate uses the
			// `{ locale: 'en', data: { … } }` shape — locale must reach the API.
			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
			});

			expect(calls[0].payload.locale).toBe('en');
		});

		it('omits locale from the payload when the mock is flat (no locale field)', async () => {
			// Override the mock with a flat shape (no locale).
			await writeFile(
				join(projectDir, 'templates', 'invoice', 'invoice.json'),
				JSON.stringify({ title: 'Flat' }),
				'utf-8'
			);

			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
			});

			expect(calls[0].payload).not.toHaveProperty('locale');
		});

		it('--data with a locale overrides the mock locale', async () => {
			const dataPath = join(tempDir, 'data.json');
			await writeFile(
				dataPath,
				JSON.stringify({
					locale: 'fr',
					data: { title: 'Bonjour' },
				}),
				'utf-8'
			);

			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				data: dataPath,
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
			});

			expect(calls[0].payload.locale).toBe('fr');
		});

		it('--data flat (no locale) drops the locale even if the mock had one', async () => {
			const dataPath = join(tempDir, 'data.json');
			await writeFile(
				dataPath,
				JSON.stringify({ title: 'Flat override' }),
				'utf-8'
			);

			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				data: dataPath,
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
			});

			// --data fully replaces both data and locale — if the user wants
			// the mock locale, they re-add it in their override file.
			expect(calls[0].payload).not.toHaveProperty('locale');
		});
	});

	describe('environment surface', () => {
		it('returns environment "sandbox" when API responds with sandbox', async () => {
			const result = await executeRender('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient({
					render: () => ({ pdf: FAKE_PDF, environment: 'sandbox' }),
				}),
				homeDir: fakeHome,
			});
			expect(result.environment).toBe('sandbox');
		});

		it('returns environment "live" when API responds with live', async () => {
			const result = await executeRender('invoice', {
				cwd: projectDir,
				version: '1.0.5',
				apiClient: createMockApiClient({
					render: () => ({ pdf: FAKE_PDF, environment: 'live' }),
				}),
				homeDir: fakeHome,
			});
			expect(result.environment).toBe('live');
		});
	});

	describe('errors', () => {
		it('throws if the template is not declared in the manifest', async () => {
			await expect(
				executeRender('nonexistent', {
					cwd: projectDir,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/not found/i);
		});

		it('throws if not in a Poli Page project', async () => {
			await expect(
				executeRender('invoice', {
					cwd: join(tempDir, 'nowhere'),
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/poli-page\.json/i);
		});

		it('throws if neither credentials nor env var are present', async () => {
			const emptyHome = await mkdtemp(join(tmpdir(), 'poli-empty-'));
			await expect(
				executeRender('invoice', {
					cwd: projectDir,
					apiClient: createMockApiClient(),
					homeDir: emptyHome,
				})
			).rejects.toThrow(/Not logged in/i);
			await rm(emptyHome, { recursive: true, force: true });
		});
	});
});
