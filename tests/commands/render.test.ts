import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../../src/commands/init.js';
import { setupTemplate } from '../helpers/setup-template.js';
import { createFakeApiClient } from '../helpers/fake-api-client.js';
import { testApiKey } from '../helpers/api-key.js';
import {
	executeRender,
	parseTemplateSpec,
	formatRenderJson,
	renderLabel,
} from '../../src/commands/render.js';
import { writeCredentials } from '../../src/credentials.js';
import { writeManifest, readManifest } from '../../src/manifest.js';
import { errorToExitCode } from '../../src/exit-codes.js';
import {
	ApiError,
	OverageCapError,
	type ApiClient,
	type RenderResult,
} from '../../src/api-client.js';

const FAKE_PDF = Buffer.from('%PDF-1.4 fake pdf content');
const DRAFT_PDF = Buffer.from('%PDF-1.7 draft pdf bytes');

function makeFakeDescriptor(overrides: Partial<RenderResult> = {}): RenderResult {
	return {
		documentId: 'doc_abc',
		organizationId: 'org_uuid_acme',
		projectId: 'proj_1',
		projectSlug: 'test-project',
		templateId: 'tpl_1',
		templateSlug: 'invoice',
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
		diagnostics: [],
		...overrides,
	};
}

interface RenderCall {
	route: 'render' | 'renderDraft';
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
	return createFakeApiClient({
		render: async (authorization, orgIdHeader, payload) => {
			const call: RenderCall = { route: 'render', authorization, orgIdHeader, payload };
			options.calls?.push(call);
			return options.render ? options.render(call) : makeFakeDescriptor();
		},
		renderDraft: async (authorization, orgIdHeader, payload) => {
			options.calls?.push({ route: 'renderDraft', authorization, orgIdHeader, payload });
			return DRAFT_PDF;
		},
	});
}

/** A client that fails the test on any call: the command must refuse first. */
const noCallClient = (): ApiClient => createFakeApiClient({});

const fakeFetchPdf = async (): Promise<Buffer> => FAKE_PDF;

async function expectUsageError(promise: Promise<unknown>, message: RegExp): Promise<void> {
	const error = await promise.then(
		() => {
			throw new Error('expected the render to be refused');
		},
		(err: unknown) => err
	);
	expect((error as Error).message).toMatch(message);
	expect(errorToExitCode(error)).toBe(2);
}

describe('formatRenderJson', () => {
	it('includes outputPath when a file was written', () => {
		const descriptor = makeFakeDescriptor();
		const json = formatRenderJson({
			kind: 'environment',
			descriptor,
			outputPath: '/tmp/foo.pdf',
		});
		expect(json).toMatchObject({
			documentId: 'doc_abc',
			outputPath: '/tmp/foo.pdf',
		});
	});

	it('omits outputPath when no file was written (e.g. --no-download)', () => {
		const descriptor = makeFakeDescriptor();
		const json = formatRenderJson({ kind: 'environment', descriptor });
		expect((json as Record<string, unknown>).outputPath).toBeUndefined();
		// All descriptor fields still present
		expect((json as Record<string, unknown>).documentId).toBe('doc_abc');
	});

	it('prints { template, environment: "draft", outputPath } for a draft render', () => {
		const json = formatRenderJson({
			kind: 'draft',
			template: 'invoice',
			outputPath: '/tmp/invoice.pdf',
		});
		expect(json).toEqual({
			template: 'invoice',
			environment: 'draft',
			outputPath: '/tmp/invoice.pdf',
		});
	});
});

describe('renderLabel', () => {
	it('reads @draft for the draft, never billed', () => {
		expect(renderLabel('invoice', 'draft')).toBe('invoice@draft');
	});

	it('reads @sandbox for sandbox, not billed', () => {
		expect(renderLabel('invoice', 'sandbox')).toBe('invoice@sandbox');
	});

	it.each(['live', 'production', 'staging'])('marks @%s as billed', (env) => {
		expect(renderLabel('invoice', env)).toBe(`invoice@${env} (billed)`);
	});
});

describe('poli render', () => {
	let tempDir: string;
	let projectDir: string;
	let fakeHome: string;
	let emptyHome: string;
	let savedEnvKey: string | undefined;
	const noSleep = async (): Promise<void> => {};

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-render-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-home-'));
		emptyHome = await mkdtemp(join(tmpdir(), 'poli-empty-'));
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
		await rm(emptyHome, { recursive: true, force: true });
		if (savedEnvKey === undefined) {
			delete process.env.POLI_PAGE_API_KEY;
		} else {
			process.env.POLI_PAGE_API_KEY = savedEnvKey;
		}
	});

	describe('draft with a session', () => {
		it('renders through renderDraft with the session and X-Poli-Org-Id', async () => {
			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
			});

			expect(calls).toHaveLength(1);
			expect(calls[0].route).toBe('renderDraft');
			expect(calls[0].authorization).toBe('Bearer mock-session-token');
			expect(calls[0].orgIdHeader).toBe('org_uuid_acme');
		});

		it('sends project, template, data, format and orientation; no environment, no version', async () => {
			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
			});

			expect(calls[0].payload).toMatchObject({
				project: 'test-project',
				template: 'invoice',
				format: 'A4',
				orientation: 'portrait',
			});
			expect(calls[0].payload.data).toBeDefined();
			expect(calls[0].payload).not.toHaveProperty('environment');
			expect(calls[0].payload).not.toHaveProperty('version');
		});

		it('writes the returned PDF to output/<name>/<format-orientation>/<name>.pdf', async () => {
			const result = await executeRender('invoice', {
				cwd: projectDir,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			expect(result).toEqual({
				kind: 'draft',
				template: 'invoice',
				outputPath: join(projectDir, 'output', 'invoice', 'a4-portrait', 'invoice.pdf'),
			});
			expect(await readFile(result.outputPath!)).toEqual(DRAFT_PDF);
		});

		it('honours -o', async () => {
			const customPath = join(tempDir, 'draft.pdf');
			const result = await executeRender('invoice', {
				cwd: projectDir,
				output: customPath,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});
			expect(result.outputPath).toBe(customPath);
			expect(await readFile(customPath)).toEqual(DRAFT_PDF);
		});

		it('treats an explicit @draft like the bare name', async () => {
			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				target: 'draft',
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
			});
			expect(calls.map((c) => c.route)).toEqual(['renderDraft']);
		});

		it('refuses --no-download: the draft is never stored, so there is no document', async () => {
			await expectUsageError(
				executeRender('invoice', {
					cwd: projectDir,
					noDownload: true,
					apiClient: noCallClient(),
					homeDir: fakeHome,
				}),
				/--no-download.*`invoice@<environment>`/
			);
		});

		it('throws a friendly error when manifest has no cloud section', async () => {
			const manifest = await readManifest(projectDir);
			delete manifest.cloud;
			await writeManifest(projectDir, manifest);

			await expect(
				executeRender('invoice', {
					cwd: projectDir,
					apiClient: noCallClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/isn't linked|poli link/i);
		});
	});

	describe('environment with a session', () => {
		it('sends environment: <env> to render, with no version', async () => {
			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				target: 'staging',
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
				fetchPdf: fakeFetchPdf,
			});

			expect(calls).toHaveLength(1);
			expect(calls[0].route).toBe('render');
			expect(calls[0].authorization).toBe('Bearer mock-session-token');
			expect(calls[0].orgIdHeader).toBe('org_uuid_acme');
			expect(calls[0].payload).toMatchObject({
				project: 'test-project',
				template: 'invoice',
				environment: 'staging',
			});
			expect(calls[0].payload).not.toHaveProperty('version');
		});

		it('downloads the stored PDF to the default path', async () => {
			const result = await executeRender('invoice', {
				cwd: projectDir,
				target: 'sandbox',
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
				fetchPdf: fakeFetchPdf,
			});

			expect(result.outputPath).toContain(
				join('output', 'invoice', 'a4-portrait', 'invoice.pdf')
			);
			const stats = await stat(result.outputPath!);
			expect(stats.isFile()).toBe(true);
			expect(await readFile(result.outputPath!)).toEqual(FAKE_PDF);
		});

		it('accepts a 20-character hyphenated environment name', async () => {
			const env = 'eu-west-staging-0001';
			expect(env).toHaveLength(20);
			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				target: env,
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
				fetchPdf: fakeFetchPdf,
			});
			expect(calls[0].payload.environment).toBe(env);
		});
	});

	describe('api-key mode', () => {
		it('renders a matching environment with the key and no org header', async () => {
			process.env.POLI_PAGE_API_KEY = testApiKey('staging');

			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				target: 'staging',
				apiClient: createMockApiClient({ calls }),
				homeDir: emptyHome,
				fetchPdf: fakeFetchPdf,
			});

			expect(calls).toHaveLength(1);
			expect(calls[0].route).toBe('render');
			expect(calls[0].authorization).toBe(`Bearer ${testApiKey('staging')}`);
			expect(calls[0].orgIdHeader).toBeUndefined();
			expect(calls[0].payload.environment).toBe('staging');
		});

		it("refuses another environment before any call, naming the key's environment", async () => {
			process.env.POLI_PAGE_API_KEY = testApiKey('staging');

			await expectUsageError(
				executeRender('invoice', {
					cwd: projectDir,
					target: 'production',
					apiClient: noCallClient(),
					homeDir: emptyHome,
				}),
				/key renders the `staging` environment, not `production`/
			);
		});

		it('refuses the draft before any call', async () => {
			process.env.POLI_PAGE_API_KEY = testApiKey('staging');

			await expectUsageError(
				executeRender('invoice', {
					cwd: projectDir,
					apiClient: noCallClient(),
					homeDir: emptyHome,
				}),
				/API keys render a published environment: use `invoice@<environment>`/
			);
		});

		it('refuses an explicit @draft before any call', async () => {
			process.env.POLI_PAGE_API_KEY = testApiKey('live');

			await expectUsageError(
				executeRender('invoice', {
					cwd: projectDir,
					target: 'draft',
					apiClient: noCallClient(),
					homeDir: emptyHome,
				}),
				/API keys render a published environment/
			);
		});
	});

	describe('spec target validation', () => {
		it.each(['1.2.3', '1.0', 'latest'])(
			'refuses %s, pointing to name@<environment>',
			async (target) => {
				await expectUsageError(
					executeRender('invoice', {
						cwd: projectDir,
						target,
						apiClient: noCallClient(),
						homeDir: fakeHome,
					}),
					new RegExp(
						`\`invoice@${target.replace(/\./g, '\\.')}\`.*\`invoice@<environment>\``
					)
				);
			}
		);

		it.each([
			['uppercase', 'Staging'],
			['an underscore', 'stag_ing'],
			['a leading hyphen', '-staging'],
			['a trailing hyphen', 'staging-'],
			['a double hyphen', 'stag--ing'],
			['21 characters', 'a'.repeat(21)],
			['a dot', 'v1.2'],
		])('refuses an environment name with %s', async (_label, target) => {
			await expectUsageError(
				executeRender('invoice', {
					cwd: projectDir,
					target,
					apiClient: noCallClient(),
					homeDir: fakeHome,
				}),
				/Invalid environment name/
			);
		});
	});

	describe('environment render errors', () => {
		function failingClient(error: Error, calls: RenderCall[] = []): ApiClient {
			return createMockApiClient({
				calls,
				render: () => {
					throw error;
				},
			});
		}

		it('PROJECT_NOT_IN_ENVIRONMENT says the project is not published there and suggests poli publish', async () => {
			await expectUsageError(
				executeRender('invoice', {
					cwd: projectDir,
					target: 'staging',
					apiClient: failingClient(
						new ApiError(
							'PROJECT_NOT_IN_ENVIRONMENT',
							404,
							'404 PROJECT_NOT_IN_ENVIRONMENT'
						)
					),
					homeDir: fakeHome,
				}),
				/`test-project` is not published in `staging`.*`poli publish --env staging`/
			);
		});

		it('ENVIRONMENT_NOT_FOUND names the environment', async () => {
			await expectUsageError(
				executeRender('invoice', {
					cwd: projectDir,
					target: 'staging',
					apiClient: failingClient(
						new ApiError('ENVIRONMENT_NOT_FOUND', 404, '404 ENVIRONMENT_NOT_FOUND')
					),
					homeDir: fakeHome,
				}),
				/no environment `staging`/i
			);
		});

		it('TEMPLATE_NOT_FOUND names the template and the environment', async () => {
			await expectUsageError(
				executeRender('invoice', {
					cwd: projectDir,
					target: 'staging',
					apiClient: failingClient(
						new ApiError('TEMPLATE_NOT_FOUND', 404, '404 TEMPLATE_NOT_FOUND')
					),
					homeDir: fakeHome,
				}),
				/`invoice` is not in the copy of `test-project` published in `staging`.*`poli publish --env staging`/
			);
		});

		it('PUBLISH_IN_PROGRESS waits Retry-After, retries once, and returns the render', async () => {
			const calls: RenderCall[] = [];
			const sleeps: number[] = [];
			const result = await executeRender('invoice', {
				cwd: projectDir,
				target: 'staging',
				apiClient: createMockApiClient({
					calls,
					render: () => {
						if (calls.length === 1) {
							throw new ApiError(
								'PUBLISH_IN_PROGRESS',
								503,
								'503 PUBLISH_IN_PROGRESS',
								4
							);
						}
						return makeFakeDescriptor({ environment: 'staging' });
					},
				}),
				homeDir: fakeHome,
				fetchPdf: fakeFetchPdf,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			});

			expect(sleeps).toEqual([4000]);
			expect(calls).toHaveLength(2);
			expect(result.kind === 'environment' && result.descriptor.environment).toBe('staging');
		});

		it('PUBLISH_IN_PROGRESS without Retry-After waits one second', async () => {
			const calls: RenderCall[] = [];
			const sleeps: number[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				target: 'staging',
				apiClient: createMockApiClient({
					calls,
					render: () => {
						if (calls.length === 1) {
							throw new ApiError(
								'PUBLISH_IN_PROGRESS',
								503,
								'503 PUBLISH_IN_PROGRESS'
							);
						}
						return makeFakeDescriptor();
					},
				}),
				homeDir: fakeHome,
				fetchPdf: fakeFetchPdf,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			});
			expect(sleeps).toEqual([1000]);
		});

		it('PUBLISH_IN_PROGRESS twice exits 3 after a single retry', async () => {
			const calls: RenderCall[] = [];
			const sleeps: number[] = [];
			const error = await executeRender('invoice', {
				cwd: projectDir,
				target: 'staging',
				apiClient: failingClient(
					new ApiError('PUBLISH_IN_PROGRESS', 503, '503 PUBLISH_IN_PROGRESS', 2),
					calls
				),
				homeDir: fakeHome,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}).catch((err: unknown) => err);

			expect(calls).toHaveLength(2);
			expect(sleeps).toEqual([2000]);
			expect((error as Error).message).toMatch(
				/publish of `test-project` to `staging` is still running/
			);
			expect(errorToExitCode(error)).toBe(3);
		});

		it('does not retry other API errors', async () => {
			const calls: RenderCall[] = [];
			const capped = new OverageCapError('monthly cap reached');
			await expect(
				executeRender('invoice', {
					cwd: projectDir,
					target: 'live',
					apiClient: failingClient(capped, calls),
					homeDir: fakeHome,
					sleep: noSleep,
				})
			).rejects.toBe(capped);
			expect(calls).toHaveLength(1);
		});
	});

	describe('output and download', () => {
		it('uses the manifest format/orientation in the path slug', async () => {
			await setupTemplate(projectDir, 'certificate', {
				format: 'A5',
				orientation: 'landscape',
			});

			const result = await executeRender('certificate', {
				cwd: projectDir,
				apiClient: createMockApiClient(),
				homeDir: fakeHome,
			});

			expect(result.outputPath).toContain(
				join('output', 'certificate', 'a5-landscape', 'certificate.pdf')
			);
		});

		it('writes to a custom -o path', async () => {
			const customPath = join(tempDir, 'custom-output.pdf');
			const result = await executeRender('invoice', {
				cwd: projectDir,
				target: 'sandbox',
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
				target: 'sandbox',
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
			expect(result.kind === 'environment' && result.descriptor.documentId).toBe('doc_abc');
		});

		it('rejects -o + --no-download (incompatible flags) locally', async () => {
			await expect(
				executeRender('invoice', {
					cwd: projectDir,
					target: 'sandbox',
					output: '/tmp/foo.pdf',
					noDownload: true,
					apiClient: noCallClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/either.*--output.*--no-download|both/i);
		});

		it('reads custom data via -d <file> (flat shape)', async () => {
			const dataPath = join(tempDir, 'data.json');
			await writeFile(dataPath, JSON.stringify({ title: 'Custom', amount: 42 }), 'utf-8');

			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				data: dataPath,
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
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
			});

			expect(calls[0].payload.data).toEqual({ title: 'Mes nouvelles données' });
			expect(calls[0].payload.locale).toBe('fr');
		});

		it('forwards the mock locale to the API when present', async () => {
			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				target: 'sandbox',
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
			});

			expect(calls[0].payload).not.toHaveProperty('locale');
		});

		it('--data flat (no locale) drops the locale from the payload', async () => {
			const dataPath = join(tempDir, 'data.json');
			await writeFile(dataPath, JSON.stringify({ title: 'Flat override' }), 'utf-8');

			const calls: RenderCall[] = [];
			await executeRender('invoice', {
				cwd: projectDir,
				target: 'sandbox',
				data: dataPath,
				apiClient: createMockApiClient({ calls }),
				homeDir: fakeHome,
				fetchPdf: fakeFetchPdf,
			});

			expect(calls[0].payload).not.toHaveProperty('locale');
		});
	});

	describe('descriptor surface', () => {
		it('exposes the JSON descriptor, with its diagnostics, in the result', async () => {
			const diagnostics = [
				{ kind: 'clipped' as const, message: 'Row clipped', elementId: 'r1' },
			];
			const result = await executeRender('invoice', {
				cwd: projectDir,
				target: 'production',
				apiClient: createMockApiClient({
					render: () => makeFakeDescriptor({ environment: 'production', diagnostics }),
				}),
				homeDir: fakeHome,
				fetchPdf: fakeFetchPdf,
			});

			if (result.kind !== 'environment') throw new Error('expected an environment render');
			expect(result.descriptor.environment).toBe('production');
			expect(result.descriptor.diagnostics).toEqual(diagnostics);
			expect(result.descriptor.presignedPdfUrl).toBeDefined();
			expect(result.descriptor.expiresAt).toBeDefined();
		});
	});

	describe('errors', () => {
		it('throws if the template is not declared in the manifest', async () => {
			await expect(
				executeRender('nonexistent', {
					cwd: projectDir,
					apiClient: noCallClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/not found/i);
		});

		it('throws if not in a Poli Page project', async () => {
			await expect(
				executeRender('invoice', {
					cwd: join(tempDir, 'nowhere'),
					apiClient: noCallClient(),
					homeDir: fakeHome,
				})
			).rejects.toThrow(/poli-page\.json/i);
		});
	});
});

describe('parseTemplateSpec', () => {
	it('returns draft when no @ is present', () => {
		expect(parseTemplateSpec('invoice')).toEqual({
			name: 'invoice',
			target: 'draft',
		});
	});

	it('parses an environment name', () => {
		expect(parseTemplateSpec('invoice@staging')).toEqual({
			name: 'invoice',
			target: 'staging',
		});
	});

	it('parses an explicit @draft', () => {
		expect(parseTemplateSpec('invoice@draft')).toEqual({
			name: 'invoice',
			target: 'draft',
		});
	});

	it('handles slugs with hyphens and digits', () => {
		expect(parseTemplateSpec('cerfa-15776@eu-prod')).toEqual({
			name: 'cerfa-15776',
			target: 'eu-prod',
		});
	});

	it('rejects an empty spec', () => {
		expect(() => parseTemplateSpec('')).toThrow(/template name is required/i);
	});

	it('rejects a leading @ (empty name)', () => {
		expect(() => parseTemplateSpec('@staging')).toThrow(/template name is required/i);
	});

	it('rejects a trailing @ (empty environment), as invalid usage', () => {
		let error: unknown;
		try {
			parseTemplateSpec('invoice@');
		} catch (err) {
			error = err;
		}
		expect((error as Error).message).toMatch(/environment is required after `@`/i);
		expect(errorToExitCode(error)).toBe(2);
	});

	it('rejects multiple @ separators', () => {
		expect(() => parseTemplateSpec('invoice@live@staging')).toThrow(/only one `@`/i);
	});

	it('does not validate the target itself (defers to executeRender)', () => {
		// Structural only: `latest` and semver reach executeRender's
		// friendly "use name@<environment>" error instead of being mangled here.
		expect(parseTemplateSpec('invoice@latest')).toEqual({
			name: 'invoice',
			target: 'latest',
		});
		expect(parseTemplateSpec('invoice@1.0')).toEqual({
			name: 'invoice',
			target: '1.0',
		});
	});
});
