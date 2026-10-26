import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { executePublish } from '../../src/commands/publish.js';
import { createProgram } from '../../src/program.js';
import { writeCredentials } from '../../src/credentials.js';
import {
	ApiError,
	EnvironmentNotFoundError,
	EnvironmentProtectedError,
	UnsupportedFileTypeError,
	type ApiClient,
	type EnvironmentInfo,
	type PublishBody,
	type PublishResult,
} from '../../src/api-client.js';
import { ExitCode, errorToExitCode } from '../../src/exit-codes.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';
import { createFakeApiClient } from '../helpers/fake-api-client.js';

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));
vi.mock('@inquirer/prompts', () => ({ confirm: confirmMock }));

const MANIFEST = {
	project: { name: 'Invoices' },
	templates: [
		{
			name: 'invoice',
			template: 'templates/invoice/invoice.html',
			mock: 'templates/invoice/invoice.json',
		},
	],
	cloud: {
		orgSlug: 'acme',
		orgId: 'org_1',
		projectSlug: 'invoices',
		projectId: 'proj_1',
	},
};

function environment(name: string, isProtected: boolean): EnvironmentInfo {
	return {
		name,
		kind: name === 'sandbox' ? 'sandbox' : 'standard',
		protected: isProtected,
		readOnly: false,
		createdAt: '2026-10-01T00:00:00.000Z',
		projectCount: 0,
	};
}

const ENVIRONMENTS = [environment('sandbox', false), environment('live', true)];

function publishResult(over: Partial<PublishResult> = {}): PublishResult {
	return {
		environment: 'sandbox',
		project: 'invoices',
		publishedAt: '2026-10-26T10:00:00.000Z',
		bundleHash: `sha256:${'ab'.repeat(32)}`,
		logId: 'log_1',
		fileCount: 3,
		totalBytes: 120,
		...over,
	};
}

interface PublishCall {
	session: string;
	orgId: string;
	project: string;
	body: PublishBody;
}

function makeClient(calls: PublishCall[], overrides: Partial<ApiClient> = {}): ApiClient {
	return createFakeApiClient({
		listEnvironments: async () => ENVIRONMENTS,
		publish: async (session, orgId, project, body) => {
			calls.push({ session, orgId, project, body });
			return publishResult({ environment: body.environment });
		},
		...overrides,
	});
}

describe('poli publish', () => {
	let projectDir: string;
	let fakeHome: string;

	beforeEach(async () => {
		vi.stubEnv('CI', '');
		projectDir = await mkdtemp(join(tmpdir(), 'poli-publish-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-publish-home-'));
		await writeCredentials(
			{
				session: 'session-token',
				user: { id: 'u1', name: 'X', email: 'x@x' },
				orgs: { acme: {} },
			},
			fakeHome
		);
		await writeFile(join(projectDir, MANIFEST_FILENAME), JSON.stringify(MANIFEST));
		await writeFile(join(projectDir, 'tailwind.css'), '@import "tailwindcss";');
		await mkdir(join(projectDir, 'templates', 'invoice'), { recursive: true });
		await writeFile(join(projectDir, 'templates', 'invoice', 'invoice.html'), '<h1>é</h1>');
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(projectDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	function run(options: Parameters<typeof executePublish>[0], client: ApiClient) {
		return executePublish({
			cwd: projectDir,
			homeDir: fakeHome,
			apiClient: client,
			...options,
		});
	}

	describe('success', () => {
		it('publishes the bundle to the project slug with the session and the manifest org id', async () => {
			const calls: PublishCall[] = [];
			const result = await run(
				{ env: 'sandbox', message: 'First release' },
				makeClient(calls)
			);

			expect(result).toEqual(publishResult());
			expect(calls).toHaveLength(1);
			expect(calls[0].session).toBe('session-token');
			expect(calls[0].orgId).toBe('org_1');
			expect(calls[0].project).toBe('invoices');
			expect(calls[0].body.environment).toBe('sandbox');
			expect(calls[0].body.message).toBe('First release');
		});

		it('omits message when none is given', async () => {
			const calls: PublishCall[] = [];
			await run({ env: 'sandbox' }, makeClient(calls));
			expect('message' in calls[0].body).toBe(false);
		});

		it('accepts a message of exactly 500 characters', async () => {
			const calls: PublishCall[] = [];
			await run({ env: 'sandbox', message: 'x'.repeat(500) }, makeClient(calls));
			expect(calls[0].body.message).toHaveLength(500);
		});
	});

	describe('bundle', () => {
		it('holds exactly the accepted file set, each entry with its encoding', async () => {
			const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x80, 0x00, 0xab]);
			const font = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0xff]);
			await writeFile(join(projectDir, 'templates', 'invoice', 'invoice.json'), '{"n":1}');
			await writeFile(
				join(projectDir, 'templates', 'invoice', 'tailwind-additions.css'),
				'.x{}'
			);
			await mkdir(join(projectDir, 'partials'), { recursive: true });
			await writeFile(join(projectDir, 'partials', 'header.html'), '<header></header>');
			await mkdir(join(projectDir, 'assets', 'images'), { recursive: true });
			await writeFile(join(projectDir, 'assets', 'images', 'logo.png'), png);
			await mkdir(join(projectDir, 'assets', 'fonts'), { recursive: true });
			await writeFile(join(projectDir, 'assets', 'fonts', 'inter.woff2'), font);
			// Outside the accepted set: never sent.
			await writeFile(join(projectDir, '.gitignore'), 'output/\n');
			await writeFile(join(projectDir, 'README.md'), '# Invoices');
			await mkdir(join(projectDir, 'output', 'invoice'), { recursive: true });
			await writeFile(join(projectDir, 'output', 'invoice', 'invoice.pdf'), 'pdf');
			await mkdir(join(projectDir, 'node_modules', 'pkg'), { recursive: true });
			await writeFile(join(projectDir, 'node_modules', 'pkg', 'index.html'), 'x');
			await writeFile(join(projectDir, 'templates', 'invoice', 'notes.md'), 'x');

			const calls: PublishCall[] = [];
			await run({ env: 'sandbox' }, makeClient(calls));

			const manifest = await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8');
			expect(calls[0].body.files).toEqual([
				{
					path: 'assets/fonts/inter.woff2',
					encoding: 'base64',
					content: font.toString('base64'),
				},
				{
					path: 'assets/images/logo.png',
					encoding: 'base64',
					content: png.toString('base64'),
				},
				{ path: 'partials/header.html', encoding: 'utf8', content: '<header></header>' },
				{ path: MANIFEST_FILENAME, encoding: 'utf8', content: manifest },
				{ path: 'tailwind.css', encoding: 'utf8', content: '@import "tailwindcss";' },
				{ path: 'templates/invoice/invoice.html', encoding: 'utf8', content: '<h1>é</h1>' },
				{ path: 'templates/invoice/invoice.json', encoding: 'utf8', content: '{"n":1}' },
				{
					path: 'templates/invoice/tailwind-additions.css',
					encoding: 'utf8',
					content: '.x{}',
				},
			]);
		});

		it('refuses a bundle over 5 MiB locally, exit 2, without calling the API', async () => {
			await mkdir(join(projectDir, 'assets', 'images'), { recursive: true });
			// 4 MiB of bytes is about 5.3 MiB once base64-encoded.
			await writeFile(
				join(projectDir, 'assets', 'images', 'huge.png'),
				Buffer.alloc(4 * 1024 * 1024, 1)
			);
			const calls: PublishCall[] = [];
			const err = await run({ env: 'sandbox', yes: true }, makeClient(calls)).catch((e) => e);
			expect(err.message).toMatch(/5 MiB/);
			expect(errorToExitCode(err)).toBe(ExitCode.INVALID_USAGE);
			expect(calls).toHaveLength(0);
		});
	});

	describe('local validation (before any API call)', () => {
		const noCall = () => createFakeApiClient({});

		it.each(['Live', '1live', 'live_eu', 'live--eu', 'live-', '-live', 'a'.repeat(21)])(
			'refuses the environment name %j with exit 2',
			async (name) => {
				const err = await run({ env: name }, noCall()).catch((e) => e);
				expect(err.message).toContain(`"${name}"`);
				expect(err.message).toMatch(/1-20 characters/);
				expect(errorToExitCode(err)).toBe(ExitCode.INVALID_USAGE);
			}
		);

		it('accepts a 20-character name with inner hyphens', async () => {
			const calls: PublishCall[] = [];
			const name = 'eu-west-2-staging-ab';
			expect(name).toHaveLength(20);
			await run(
				{ env: name },
				makeClient(calls, { listEnvironments: async () => [environment(name, false)] })
			);
			expect(calls[0].body.environment).toBe(name);
		});

		it('requires --env: there is no default environment', async () => {
			const err = await run({}, noCall()).catch((e) => e);
			expect(err.message).toMatch(/--env/);
			expect(errorToExitCode(err)).toBe(ExitCode.INVALID_USAGE);
		});

		it('refuses --env draft: the draft is not an environment', async () => {
			const err = await run({ env: 'draft' }, noCall()).catch((e) => e);
			expect(err.message).toMatch(/draft.*not an environment/i);
			expect(errorToExitCode(err)).toBe(ExitCode.INVALID_USAGE);
		});

		it('refuses a message over 500 characters with exit 2', async () => {
			const err = await run({ env: 'sandbox', message: 'x'.repeat(501) }, noCall()).catch(
				(e) => e
			);
			expect(err.message).toMatch(/500/);
			expect(errorToExitCode(err)).toBe(ExitCode.INVALID_USAGE);
		});

		it('refuses an unlinked project (exit 6)', async () => {
			await writeFile(
				join(projectDir, MANIFEST_FILENAME),
				JSON.stringify({ ...MANIFEST, cloud: undefined })
			);
			const err = await run({ env: 'sandbox' }, noCall()).catch((e) => e);
			expect(err.message).toMatch(/poli link/);
			expect(errorToExitCode(err)).toBe(ExitCode.INVALID_LOCAL_STATE);
		});

		it('refuses a linked manifest without cloud.projectSlug (exit 6)', async () => {
			const { projectSlug: _omitted, ...cloud } = MANIFEST.cloud;
			await writeFile(
				join(projectDir, MANIFEST_FILENAME),
				JSON.stringify({ ...MANIFEST, cloud })
			);
			const err = await run({ env: 'sandbox' }, noCall()).catch((e) => e);
			expect(err.message).toMatch(/poli link/);
			expect(errorToExitCode(err)).toBe(ExitCode.INVALID_LOCAL_STATE);
		});

		it('refuses a folder without poli-page.json (exit 6)', async () => {
			await rm(join(projectDir, MANIFEST_FILENAME));
			const err = await run({ env: 'sandbox' }, noCall()).catch((e) => e);
			expect(err.message).toMatch(/No poli-page\.json/);
			expect(errorToExitCode(err)).toBe(ExitCode.INVALID_LOCAL_STATE);
		});

		it('refuses when not logged in (exit 4)', async () => {
			await rm(fakeHome, { recursive: true, force: true });
			const err = await run({ env: 'sandbox' }, noCall()).catch((e) => e);
			expect(errorToExitCode(err)).toBe(ExitCode.NOT_AUTHENTICATED);
		});
	});

	describe('unknown environment', () => {
		it('names the environment and the ones that exist, exit 2, without publishing', async () => {
			const calls: PublishCall[] = [];
			const err = await run({ env: 'staging' }, makeClient(calls)).catch((e) => e);
			expect(err).toBeInstanceOf(EnvironmentNotFoundError);
			expect(err.message).toContain('"staging"');
			expect(err.message).toContain('sandbox, live');
			expect(errorToExitCode(err)).toBe(ExitCode.INVALID_USAGE);
			expect(calls).toHaveLength(0);
		});

		it('names the environment and the others that exist when the API answers ENVIRONMENT_NOT_FOUND', async () => {
			const client = makeClient([], {
				publish: async () => {
					throw new EnvironmentNotFoundError('404 ENVIRONMENT_NOT_FOUND');
				},
			});
			const err = await run({ env: 'sandbox' }, client).catch((e) => e);
			expect(err).toBeInstanceOf(EnvironmentNotFoundError);
			expect(err.message).toContain('"sandbox"');
			expect(err.message).toContain('Environments: live.');
			expect(errorToExitCode(err)).toBe(ExitCode.INVALID_USAGE);
		});
	});

	describe('protected environment', () => {
		it('asks for confirmation and publishes on yes', async () => {
			const calls: PublishCall[] = [];
			const confirmFn = vi.fn(async () => true);
			await run({ env: 'live', confirmFn }, makeClient(calls));
			expect(confirmFn).toHaveBeenCalledWith('live');
			expect(calls).toHaveLength(1);
		});

		it('publishes nothing when the confirmation is declined', async () => {
			const calls: PublishCall[] = [];
			const err = await run(
				{ env: 'live', confirmFn: async () => false },
				makeClient(calls)
			).catch((e) => e);
			expect(err.message).toMatch(/cancelled/i);
			expect(calls).toHaveLength(0);
		});

		it('without a TTY (no confirmFn) requires --yes: exit 2 and no publish', async () => {
			const calls: PublishCall[] = [];
			const err = await run({ env: 'live' }, makeClient(calls)).catch((e) => e);
			expect(err.message).toContain('"live" is protected');
			expect(err.message).toMatch(/--yes/);
			expect(errorToExitCode(err)).toBe(ExitCode.INVALID_USAGE);
			expect(calls).toHaveLength(0);
		});

		it('--yes skips the confirmation', async () => {
			const calls: PublishCall[] = [];
			const confirmFn = vi.fn(async () => false);
			await run({ env: 'live', yes: true, confirmFn }, makeClient(calls));
			expect(confirmFn).not.toHaveBeenCalled();
			expect(calls).toHaveLength(1);
		});

		it('CI=true counts as --yes', async () => {
			vi.stubEnv('CI', 'true');
			const calls: PublishCall[] = [];
			await run({ env: 'live' }, makeClient(calls));
			expect(calls).toHaveLength(1);
		});

		it('an unprotected environment never asks', async () => {
			const calls: PublishCall[] = [];
			const confirmFn = vi.fn(async () => false);
			await run({ env: 'sandbox', confirmFn }, makeClient(calls));
			expect(confirmFn).not.toHaveBeenCalled();
			expect(calls).toHaveLength(1);
		});

		it('ENVIRONMENT_PROTECTED from the API exits 5 and says an owner or admin is required', async () => {
			const client = makeClient([], {
				publish: async () => {
					throw new EnvironmentProtectedError('403 ENVIRONMENT_PROTECTED');
				},
			});
			const err = await run({ env: 'live', yes: true }, client).catch((e) => e);
			expect(err).toBeInstanceOf(EnvironmentProtectedError);
			expect(err.message).toContain('"live"');
			expect(err.message).toMatch(/owner or admin/);
			expect(errorToExitCode(err)).toBe(ExitCode.NOT_AUTHORIZED);
		});
	});

	describe('other API errors', () => {
		it('PUBLISH_IN_PROGRESS exits 3, says another publish of the pair is running, and is not retried', async () => {
			let attempts = 0;
			const client = makeClient([], {
				publish: async () => {
					attempts += 1;
					throw new ApiError('PUBLISH_IN_PROGRESS', 409, '409 PUBLISH_IN_PROGRESS');
				},
			});
			const err = await run({ env: 'sandbox' }, client).catch((e) => e);
			expect(err.message).toMatch(/another publish/i);
			expect(err.message).toContain('invoices');
			expect(err.message).toContain('"sandbox"');
			expect(errorToExitCode(err)).toBe(ExitCode.NETWORK_OR_API_ERROR);
			expect(attempts).toBe(1);
		});

		it('UNSUPPORTED_FILE_TYPE exits 2 with the path the API names', async () => {
			const detail =
				'Unsupported project file "templates/invoice/x.svg". Accepted: poli-page.json, …';
			const client = makeClient([], {
				publish: async () => {
					throw new UnsupportedFileTypeError(detail);
				},
			});
			const err = await run({ env: 'sandbox' }, client).catch((e) => e);
			expect(err.message).toContain('templates/invoice/x.svg');
			expect(errorToExitCode(err)).toBe(ExitCode.INVALID_USAGE);
		});
	});

	describe('the command', () => {
		const API_URL = 'https://api.test';
		const RESULT = publishResult({ bundleHash: `sha256:0123456789abcdef${'0'.repeat(48)}` });
		let fetchMock: ReturnType<typeof vi.fn>;
		let publishAnswer: () => Response;
		let logs: string[];
		let errors: string[];
		let savedExitCode: typeof process.exitCode;
		let savedTTY: { stdin: boolean | undefined; stdout: boolean | undefined };

		function setTTY(stdin: boolean, stdout: boolean) {
			process.stdin.isTTY = stdin;
			process.stdout.isTTY = stdout;
		}

		function publishCalls() {
			return fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/publish'));
		}

		function poli(...args: string[]) {
			return createProgram().parseAsync(['publish', ...args], { from: 'user' });
		}

		function jsonResponse(status: number, body: unknown) {
			return new Response(JSON.stringify(body), {
				status,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		beforeEach(() => {
			vi.stubEnv('HOME', fakeHome);
			vi.stubEnv('POLI_API_URL', API_URL);
			vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
			publishAnswer = () => jsonResponse(200, RESULT);
			fetchMock = vi.fn(async (url: string) => {
				if (url.endsWith('/organizations/org_1/environments')) {
					return jsonResponse(200, ENVIRONMENTS);
				}
				if (url === `${API_URL}/v1/projects/invoices/publish`) return publishAnswer();
				return new Response('unexpected', { status: 500 });
			});
			vi.stubGlobal('fetch', fetchMock);
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
			savedTTY = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
			confirmMock.mockReset();
		});

		afterEach(() => {
			process.stdin.isTTY = savedTTY.stdin as true;
			process.stdout.isTTY = savedTTY.stdout as true;
			process.exitCode = savedExitCode;
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
		});

		it('prints the environment, project, 12-character hash, file count and log id in a TTY', async () => {
			setTTY(true, true);
			await poli('--env', 'sandbox');
			expect(errors).toEqual([]);
			expect(process.exitCode).toBeUndefined();
			expect(logs).toEqual([
				'✓ Published invoices to sandbox',
				'  Bundle:  0123456789ab (3 files)',
				'  Log id:  log_1',
			]);
			expect(publishCalls()).toHaveLength(1);
		});

		it('prints the result as JSON with --json', async () => {
			setTTY(true, true);
			await poli('--env', 'sandbox', '--json');
			expect(JSON.parse(logs.join('\n'))).toEqual(RESULT);
		});

		it('prints the result as JSON when stdout is piped', async () => {
			setTTY(true, false);
			await poli('--env', 'sandbox', '--yes');
			expect(JSON.parse(logs.join('\n'))).toEqual(RESULT);
		});

		it('--env draft exits 2 with the reason on stderr and calls no API', async () => {
			setTTY(true, true);
			await poli('--env', 'draft');
			expect(process.exitCode).toBe(ExitCode.INVALID_USAGE);
			expect(errors.join('\n')).toMatch(/draft.*not an environment/i);
			expect(logs).toEqual([]);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('PUBLISH_IN_PROGRESS from the API: the reason on stderr, exit 3, one attempt, even with --json', async () => {
			setTTY(true, true);
			publishAnswer = () =>
				jsonResponse(409, { error: 'PUBLISH_IN_PROGRESS', requestId: 'req-test' });
			await poli('--env', 'sandbox', '--json');
			expect(process.exitCode).toBe(ExitCode.NETWORK_OR_API_ERROR);
			expect(errors).toEqual([
				'Another publish of invoices to "sandbox" is running. Wait for it to finish, then publish again.',
			]);
			expect(logs).toEqual([]);
			expect(publishCalls()).toHaveLength(1);
		});

		it('UNSUPPORTED_FILE_TYPE from the API: the path it names on stderr, exit 2', async () => {
			setTTY(true, true);
			publishAnswer = () =>
				jsonResponse(400, {
					error: 'UNSUPPORTED_FILE_TYPE',
					detail: 'Unsupported project file "templates/invoice/x.svg".',
					requestId: 'req-test',
				});
			await poli('--env', 'sandbox');
			expect(process.exitCode).toBe(ExitCode.INVALID_USAGE);
			expect(errors.join('\n')).toContain('templates/invoice/x.svg');
			expect(logs).toEqual([]);
		});

		it('asks before publishing to a protected environment when stdin and stdout are TTYs', async () => {
			setTTY(true, true);
			confirmMock.mockResolvedValue(true);
			await poli('--env', 'live');
			expect(confirmMock).toHaveBeenCalledWith({
				message: '"live" is a protected environment. Publish to it?',
				default: false,
			});
			expect(publishCalls()).toHaveLength(1);
		});

		it.each([
			['stdin', false, true],
			['stdout', true, false],
		])(
			'does not prompt when %s is not a TTY: a protected environment needs --yes (exit 2)',
			async (_stream, stdin, stdout) => {
				setTTY(stdin, stdout);
				await poli('--env', 'live');
				expect(confirmMock).not.toHaveBeenCalled();
				expect(process.exitCode).toBe(ExitCode.INVALID_USAGE);
				expect(errors.join('\n')).toMatch(/--yes/);
				expect(publishCalls()).toHaveLength(0);
			}
		);
	});
});
