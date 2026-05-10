import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../../src/commands/init.js';
import { setupTemplate } from '../helpers/setup-template.js';
import { executePreview } from '../../src/commands/preview.js';
import { writeCredentials } from '../../src/credentials.js';
import { writeManifest, readManifest } from '../../src/manifest.js';
import type { ApiClient, PreviewApiResult } from '../../src/api-client.js';

const FAKE_HTML = '<!doctype html><html><body>preview</body></html>';

function makeFakePreview(overrides: Partial<PreviewApiResult> = {}): PreviewApiResult {
	return {
		html: FAKE_HTML,
		totalPages: 2,
		environment: 'sandbox',
		...overrides,
	};
}

interface PreviewCall {
	authorization: string;
	orgIdHeader: string | undefined;
	payload: Record<string, unknown>;
}

function createMockApiClient(
	options: {
		preview?: (call: PreviewCall) => PreviewApiResult | Promise<PreviewApiResult>;
		previewCalls?: PreviewCall[];
	} = {}
): ApiClient {
	const defaultPreview = (): PreviewApiResult => makeFakePreview();
	return {
		signIn: async () => ({
			user: { id: 'user_1', name: 'Test', email: 'test@test.com' },
			session: 'mock-session',
		}),
		getOrganizations: async () => [{ id: 'org_1', name: 'Acme', slug: 'acme' }],
		render: async () => {
			throw new Error('render should not be called from preview tests');
		},
		renderPreview: async (authorization, orgIdHeader, payload) => {
			const call: PreviewCall = { authorization, orgIdHeader, payload };
			options.previewCalls?.push(call);
			return options.preview ? options.preview(call) : defaultPreview();
		},
	} as unknown as ApiClient;
}

describe('poli preview', () => {
	let tempDir: string;
	let projectDir: string;
	let fakeHome: string;
	let savedEnvKey: string | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-preview-'));
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

	describe('payload shape', () => {
		it('sends project + template + version + data + format + orientation', async () => {
			const previewCalls: PreviewCall[] = [];
			await executePreview('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient({ previewCalls }),
				homeDir: fakeHome,
			});

			expect(previewCalls).toHaveLength(1);
			expect(previewCalls[0].payload.project).toBe('test-project');
			expect(previewCalls[0].payload.template).toBe('invoice');
			expect(previewCalls[0].payload.version).toBe('draft');
			expect(previewCalls[0].payload.data).toBeDefined();
			expect(previewCalls[0].payload.format).toBe('A4');
			expect(previewCalls[0].payload.orientation).toBe('portrait');
		});
	});

	describe('default output', () => {
		it('writes the HTML to output/<template>/<format-orientation>/output.html', async () => {
			const result = await executePreview('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			expect(result.outputPath).toContain(
				join('output', 'invoice', 'a4-portrait', 'output.html')
			);
			const stats = await stat(result.outputPath!);
			expect(stats.isFile()).toBe(true);
			const content = await readFile(result.outputPath!, 'utf-8');
			expect(content).toBe(FAKE_HTML);
		});

		it('returns a descriptor with templateSlug, version, environment, format, orientation, pageCount', async () => {
			const result = await executePreview('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			expect(result.descriptor.templateSlug).toBe('invoice');
			expect(result.descriptor.projectSlug).toBe('test-project');
			expect(result.descriptor.version).toBe('draft');
			expect(result.descriptor.environment).toBe('sandbox');
			expect(result.descriptor.format).toBe('A4');
			expect(result.descriptor.orientation).toBe('portrait');
			expect(result.descriptor.pageCount).toBe(2);
		});

		it('does NOT include `html` in the descriptor when a file was written', async () => {
			const result = await executePreview('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			expect(result.descriptor.html).toBeUndefined();
		});
	});

	describe('--no-download', () => {
		it('does not write any file', async () => {
			const result = await executePreview('invoice', {
				cwd: projectDir,
				noDownload: true,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			expect(result.outputPath).toBeUndefined();
			expect(result.descriptor.outputPath).toBeUndefined();
			await expect(
				stat(join(projectDir, 'output', 'invoice', 'a4-portrait', 'output.html'))
			).rejects.toThrow();
		});

		it('exposes the rendered HTML on the descriptor', async () => {
			const result = await executePreview('invoice', {
				cwd: projectDir,
				noDownload: true,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			expect(result.descriptor.html).toBe(FAKE_HTML);
		});

		it('still calls the API exactly once (no fetch retry)', async () => {
			const previewCalls: PreviewCall[] = [];
			await executePreview('invoice', {
				cwd: projectDir,
				noDownload: true,
				apiClient: createMockApiClient({ previewCalls }),
				homeDir: fakeHome,
			});

			expect(previewCalls).toHaveLength(1);
		});
	});

	describe('-o output flag', () => {
		it('writes the HTML to a custom -o path', async () => {
			const customPath = join(tempDir, 'custom-preview.html');
			const result = await executePreview('invoice', {
				cwd: projectDir,
				output: customPath,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			expect(result.outputPath).toBe(customPath);
			const content = await readFile(customPath, 'utf-8');
			expect(content).toBe(FAKE_HTML);
		});

		it('rejects -o + --no-download as incompatible flags', async () => {
			await expect(
				executePreview('invoice', {
					cwd: projectDir,
					output: '/tmp/foo.html',
					noDownload: true,
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/either.*--output.*--no-download|both/i);
		});
	});

	describe('--version validation', () => {
		it('defaults to "draft" when not specified', async () => {
			const previewCalls: PreviewCall[] = [];
			await executePreview('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient({ previewCalls }),
				homeDir: fakeHome,
			});
			expect(previewCalls[0].payload.version).toBe('draft');
		});

		it('passes through an exact semver like 1.2.3', async () => {
			const previewCalls: PreviewCall[] = [];
			await executePreview('invoice', {
				cwd: projectDir,
				version: '1.2.3',
				apiClient: createMockApiClient({ previewCalls }),
				homeDir: fakeHome,
			});
			expect(previewCalls[0].payload.version).toBe('1.2.3');
		});

		it('rejects "latest" locally with a friendly message', async () => {
			await expect(
				executePreview('invoice', {
					cwd: projectDir,
					version: 'latest',
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/latest.*retired/i);
		});

		it('rejects partial semver "1.0"', async () => {
			await expect(
				executePreview('invoice', {
					cwd: projectDir,
					version: '1.0',
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/exact semver|X\.Y\.Z/i);
		});

		it('rejects unknown formats locally', async () => {
			await expect(
				executePreview('invoice', {
					cwd: projectDir,
					version: 'banana',
					apiClient: createMockApiClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/Invalid version/i);
		});
	});

	describe('--data flag', () => {
		it('reads custom data via -d <file> (flat shape)', async () => {
			const dataPath = join(tempDir, 'data.json');
			await writeFile(
				dataPath,
				JSON.stringify({ title: 'Custom', amount: 42 }),
				'utf-8'
			);

			const previewCalls: PreviewCall[] = [];
			await executePreview('invoice', {
				cwd: projectDir,
				data: dataPath,
				apiClient: createMockApiClient({ previewCalls }),
				homeDir: fakeHome,
			});

			expect(previewCalls[0].payload.data).toEqual({ title: 'Custom', amount: 42 });
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

			const previewCalls: PreviewCall[] = [];
			await executePreview('invoice', {
				cwd: projectDir,
				data: dataPath,
				apiClient: createMockApiClient({ previewCalls }),
				homeDir: fakeHome,
			});

			expect(previewCalls[0].payload.data).toEqual({
				title: 'Mes nouvelles données',
			});
			expect(previewCalls[0].payload.locale).toBe('fr');
		});
	});
});
