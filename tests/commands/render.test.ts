import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../../src/commands/init.js';
import { setupTemplate } from '../helpers/setup-template.js';
import { executeRender } from '../../src/commands/render.js';
import { writeCredentials } from '../../src/credentials.js';
import { writeManifest, readManifest } from '../../src/manifest.js';
import type { ApiClient, RenderResult } from '../../src/api-client.js';

const FAKE_PDF = Buffer.from('%PDF-1.4 fake pdf content');

function makeFakeDescriptor(overrides: Partial<RenderResult> = {}): RenderResult {
	return {
		documentId: 'doc_abc',
		organizationId: 'org_uuid_acme',
		projectId: 'proj_1',
		projectSlug: 'test-project',
		templateId: 'tpl_1',
		templateSlug: 'invoice',
		version: 'draft',
		environment: 'sandbox',
		apiKeyId: null,
		createdAt: '2026-05-07T10:00:00.000Z',
		pageCount: 1,
		sizeBytes: FAKE_PDF.length,
		format: 'A4',
		orientation: 'portrait',
		locale: 'en',
		metadata: {},
		presignedPdfUrl: 'https://s3.example/doc_abc.pdf?sig=abc',
		expiresAt: '2026-05-07T10:15:00.000Z',
		...overrides,
	};
}

interface RenderCall {
	authorization: string;
	orgIdHeader: string | undefined;
	payload: Record<string, unknown>;
}

function createMockApiClient(
	options: {
		render?: (call: RenderCall) => RenderResult | Promise<RenderResult>;
		calls?: RenderCall[];
	} = {}
): ApiClient {
	const defaultRender = (): RenderResult => makeFakeDescriptor();
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
		render: async (authorization, orgIdHeader, payload) => {
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
	} as unknown as ApiClient;
}

const fakeFetchPdf = async (): Promise<Buffer> => FAKE_PDF;

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
				fetchPdf: fakeFetchPdf,
			});

			expect(calls).toHaveLength(1);
			expect(calls[0].authorization).toBe('Bearer mock-session-token');
			expect(calls[0].orgIdHeader).toBe('org_uuid_acme');
		});

		it('throws a friendly error when manifest has no cloud section', async () => {
			const manifest = await readManifest(projectDir);
			delete manifest.cloud;
			await writeManifest(projectDir, manifest);

			await expect(
				executeRender('invoice', {
					cwd: projectDir,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
					fetchPdf: fakeFetchPdf,
				})
			).rejects.toThrow(/isn't linked|poli link/i);
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
				fetchPdf: fakeFetchPdf,
			});

			expect(calls[0].authorization).toBe('Bearer pp_test_envkey');
			expect(calls[0].orgIdHeader).toBeUndefined();
			await rm(emptyHome, { recursive: true, force: true });
		});
	});

	describe('payload shape', () => {
		it('sends project (slug) + template (name) + version + data', async () => {
			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				version: '1.2.3',
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
				fetchPdf: fakeFetchPdf,
			});

			expect(calls[0].payload.project).toBe('test-project');
			expect(calls[0].payload.template).toBe('invoice');
			expect(calls[0].payload.version).toBe('1.2.3');
			expect(calls[0].payload.data).toBeDefined();
		});
	});

	describe('--version validation', () => {
		it('defaults to "draft" when not specified', async () => {
			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
				fetchPdf: fakeFetchPdf,
			});
			expect(calls[0].payload.version).toBe('draft');
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

	describe('output and download', () => {
		it('writes the PDF to output/<name>/<name>.pdf by default', async () => {
			const result = await executeRender('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
				fetchPdf: fakeFetchPdf,
			});

			expect(result.outputPath).toContain(join('output', 'invoice', 'invoice.pdf'));
			const stats = await stat(result.outputPath!);
			expect(stats.isFile()).toBe(true);
			const content = await readFile(result.outputPath!);
			expect(content).toEqual(FAKE_PDF);
		});

		it('writes to a custom -o path', async () => {
			const customPath = join(tempDir, 'custom-output.pdf');
			const result = await executeRender('invoice', {
				cwd: projectDir,
				output: customPath,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
				fetchPdf: fakeFetchPdf,
			});
			expect(result.outputPath).toBe(customPath);
		});

		it('--no-download skips the fetch and returns only the descriptor', async () => {
			let fetchCalled = 0;
			const result = await executeRender('invoice', {
				cwd: projectDir,
				noDownload: true,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
				fetchPdf: async () => {
					fetchCalled += 1;
					return Buffer.alloc(0);
				},
			});

			expect(fetchCalled).toBe(0);
			expect(result.outputPath).toBeUndefined();
			expect(result.descriptor.documentId).toBe('doc_abc');
			expect(result.descriptor.presignedPdfUrl).toMatch(/s3\.example/);
		});

		it('rejects -o + --no-download (incompatible flags) locally', async () => {
			await expect(
				executeRender('invoice', {
					cwd: projectDir,
					output: '/tmp/foo.pdf',
					noDownload: true,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/either.*--output.*--no-download|both/i);
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
				fetchPdf: fakeFetchPdf,
			});

			expect(calls[0].payload.data).toEqual({ title: 'Custom', amount: 42 });
		});

		it('unwraps the wrapped { locale, data: {...} } shape from --data', async () => {
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
				fetchPdf: fakeFetchPdf,
			});

			expect(calls[0].payload.data).toEqual({ title: 'Mes nouvelles données' });
			expect(calls[0].payload.locale).toBe('fr');
		});

		it('forwards the mock locale to the API when present', async () => {
			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
				fetchPdf: fakeFetchPdf,
			});
			expect(calls[0].payload.locale).toBe('en');
		});

		it('omits locale from the payload when the mock is flat', async () => {
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
				fetchPdf: fakeFetchPdf,
			});

			expect(calls[0].payload).not.toHaveProperty('locale');
		});

		it('--data flat (no locale) drops the locale from the payload', async () => {
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
				fetchPdf: fakeFetchPdf,
			});

			expect(calls[0].payload).not.toHaveProperty('locale');
		});
	});

	describe('descriptor surface', () => {
		it('exposes the JSON descriptor in the result', async () => {
			const result = await executeRender('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
				fetchPdf: fakeFetchPdf,
			});

			expect(result.descriptor.documentId).toBe('doc_abc');
			expect(result.descriptor.environment).toBe('sandbox');
			expect(result.descriptor.presignedPdfUrl).toBeDefined();
			expect(result.descriptor.expiresAt).toBeDefined();
		});

		it('returns environment "live" when the API responds with live', async () => {
			const result = await executeRender('invoice', {
				cwd: projectDir,
				version: '1.0.5',
				apiClient: createMockApiClient({
					render: () =>
						makeFakeDescriptor({ environment: 'live', version: '1.0.5' }),
				}),
				homeDir: fakeHome,
				fetchPdf: fakeFetchPdf,
			});
			expect(result.descriptor.environment).toBe('live');
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
	});
});
