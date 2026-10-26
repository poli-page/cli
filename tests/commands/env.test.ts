import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createProgram } from '../../src/program.js';
import { writeCredentials } from '../../src/credentials.js';
import type {
	EnvironmentInfo,
	ProjectEnvironmentState,
	PublishLogEntry,
} from '../../src/api-client.js';
import { ExitCode } from '../../src/exit-codes.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';

const API_URL = 'https://api.test';

const LINKED_MANIFEST = {
	project: { name: 'Invoices' },
	templates: [],
	cloud: { orgSlug: 'acme', orgId: 'org_1', projectSlug: 'invoices', projectId: 'proj_1' },
};

const ACME = { id: 'org_1', name: 'Acme', slug: 'acme' };
const GLOBEX = { id: 'org_2', name: 'Globex', slug: 'globex' };

function environment(over: Partial<EnvironmentInfo> & { name: string }): EnvironmentInfo {
	return {
		kind: 'standard',
		protected: false,
		readOnly: false,
		createdAt: '2026-10-01T00:00:00.000Z',
		projectCount: 0,
		...over,
	};
}

const ORG_ENVIRONMENTS: EnvironmentInfo[] = [
	environment({ name: 'sandbox', kind: 'sandbox', projectCount: 3 }),
	environment({ name: 'live', protected: true, projectCount: 2 }),
	environment({ name: 'staging', readOnly: true, projectCount: 0 }),
];

function logEntry(over: Partial<PublishLogEntry> = {}): PublishLogEntry {
	return {
		id: 'log_1',
		status: 'succeeded',
		errorCode: null,
		startedAt: '2026-10-26T09:59:58.000Z',
		publishedAt: '2026-10-26T10:00:00.000Z',
		author: { type: 'user', id: 'u1', displayName: 'Ada Lovelace' },
		message: 'Invoice footer fix',
		bundleHash: `sha256:0123456789abcdef${'0'.repeat(48)}`,
		fileCount: 3,
		totalBytes: 120,
		...over,
	};
}

const PROJECT_ENVIRONMENTS: ProjectEnvironmentState[] = [
	{
		environment: 'sandbox',
		kind: 'sandbox',
		protected: false,
		readOnly: false,
		published: true,
		lastPublish: logEntry(),
	},
	{
		environment: 'live',
		kind: 'standard',
		protected: true,
		readOnly: false,
		published: false,
		lastPublish: null,
	},
	{
		environment: 'staging',
		kind: 'standard',
		protected: false,
		readOnly: true,
		published: false,
		lastPublish: logEntry({
			id: 'log_2',
			status: 'failed',
			errorCode: 'PUBLISH_ABORTED',
			startedAt: '2026-10-25T08:30:00.000Z',
			publishedAt: null,
			author: { type: 'service-key', id: 'sk_1', displayName: 'CI deploy' },
			message: null,
			bundleHash: `sha256:fedcba9876543210${'0'.repeat(48)}`,
		}),
	},
	{
		environment: 'preview',
		kind: 'standard',
		protected: false,
		readOnly: false,
		published: true,
		lastPublish: logEntry({
			id: 'log_3',
			status: 'in-progress',
			startedAt: '2026-10-26T11:15:00.000Z',
			publishedAt: null,
			message: 'Next release',
			bundleHash: `sha256:abcdefabcdef${'0'.repeat(52)}`,
		}),
	},
];

describe('poli env list', () => {
	let projectDir: string;
	let fakeHome: string;
	let orgs: Array<{ id: string; name: string; slug: string }>;
	let fetchMock: ReturnType<typeof vi.fn>;
	let logs: string[];
	let errors: string[];
	let savedExitCode: typeof process.exitCode;
	let savedTTY: boolean | undefined;

	function jsonResponse(status: number, body: unknown) {
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	function requestedUrls(): string[] {
		return fetchMock.mock.calls.map(([url]) => String(url));
	}

	function poli(...args: string[]) {
		return createProgram().parseAsync(['env', 'list', ...args], { from: 'user' });
	}

	function linkProject(manifest: unknown = LINKED_MANIFEST) {
		return writeFile(join(projectDir, MANIFEST_FILENAME), JSON.stringify(manifest));
	}

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), 'poli-env-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-env-home-'));
		await writeCredentials(
			{
				session: 'session-token',
				user: { id: 'u1', name: 'X', email: 'x@x' },
				orgs: {},
			},
			fakeHome
		);
		vi.stubEnv('HOME', fakeHome);
		vi.stubEnv('POLI_API_URL', API_URL);
		vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
		orgs = [ACME];
		fetchMock = vi.fn(async (url: string) => {
			if (url === `${API_URL}/api/organizations`) return jsonResponse(200, orgs);
			if (url === `${API_URL}/api/organizations/org_1/environments`) {
				return jsonResponse(200, ORG_ENVIRONMENTS);
			}
			if (url === `${API_URL}/api/organizations/org_2/environments`) {
				return jsonResponse(200, [environment({ name: 'sandbox', kind: 'sandbox' })]);
			}
			if (url === `${API_URL}/api/organizations/org_1/projects/proj_1/environments`) {
				return jsonResponse(200, PROJECT_ENVIRONMENTS);
			}
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
		savedTTY = process.stdout.isTTY;
		process.stdout.isTTY = true;
	});

	afterEach(async () => {
		process.stdout.isTTY = savedTTY as true;
		process.exitCode = savedExitCode;
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		await rm(projectDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	describe('in a linked folder', () => {
		beforeEach(() => linkProject());

		it("prints each environment with the project's published state and last publish", async () => {
			await poli();

			expect(errors).toEqual([]);
			expect(process.exitCode).toBeUndefined();
			expect(logs).toEqual([
				'Environments of acme, project invoices:',
				'',
				'  ENVIRONMENT  PROTECTED  READ-ONLY  PUBLISHED  LAST PUBLISH',
				'  sandbox      no         no         yes        succeeded  2026-10-26 10:00 UTC  Ada Lovelace  0123456789ab  Invoice footer fix',
				'  live         yes        no         no         not published',
				'  staging      no         yes        no         failed (PUBLISH_ABORTED)  2026-10-25 08:30 UTC  CI deploy  fedcba987654',
				'  preview      no         no         yes        in-progress  2026-10-26 11:15 UTC  Ada Lovelace  abcdefabcdef  Next release',
			]);
			expect(requestedUrls()).toEqual([
				`${API_URL}/api/organizations`,
				`${API_URL}/api/organizations/org_1/projects/proj_1/environments`,
			]);
		});

		it('a failed last publish without an error code shows as failed alone', async () => {
			const failed = logEntry({ status: 'failed', errorCode: null, publishedAt: null });
			fetchMock.mockImplementation(async (url: string) =>
				url.endsWith('/projects/proj_1/environments')
					? jsonResponse(200, [{ ...PROJECT_ENVIRONMENTS[0], lastPublish: failed }])
					: jsonResponse(200, orgs)
			);
			await poli();
			expect(logs[3]).toBe(
				'  sandbox      no         no         yes        failed  2026-10-26 09:59 UTC  Ada Lovelace  0123456789ab  Invoice footer fix'
			);
		});

		it('control characters in the author and message cannot break the table', async () => {
			const entry = logEntry({
				author: { type: 'user', id: 'u1', displayName: 'Ada\r\nLovelace' },
				message: 'fix\n  live   yes\u001b[2J\u0007',
			});
			const states = [{ ...PROJECT_ENVIRONMENTS[0], lastPublish: entry }];
			fetchMock.mockImplementation(async (url: string) =>
				url.endsWith('/projects/proj_1/environments')
					? jsonResponse(200, states)
					: jsonResponse(200, orgs)
			);
			await poli();
			expect(logs[3]).toBe(
				'  sandbox      no         no         yes        succeeded  2026-10-26 10:00 UTC  Ada Lovelace  0123456789ab  fix   live   yes [2J '
			);

			logs = [];
			await poli('--json');
			expect(JSON.parse(logs.join('\n'))).toEqual(states);
		});

		it('prints the API answer as JSON with --json', async () => {
			await poli('--json');
			expect(JSON.parse(logs.join('\n'))).toEqual(PROJECT_ENVIRONMENTS);
		});

		it('prints the API answer as JSON when stdout is piped', async () => {
			process.stdout.isTTY = false;
			await poli();
			expect(JSON.parse(logs.join('\n'))).toEqual(PROJECT_ENVIRONMENTS);
		});

		it('names the project by its id when the manifest has no projectSlug', async () => {
			const { projectSlug: _, ...cloud } = LINKED_MANIFEST.cloud;
			await linkProject({ ...LINKED_MANIFEST, cloud });
			await poli();
			expect(logs[0]).toBe('Environments of acme, project proj_1:');
		});

		it("--org naming the linked organization keeps the project's columns", async () => {
			orgs = [ACME, GLOBEX];
			await poli('--org', 'acme');
			expect(logs[0]).toBe('Environments of acme, project invoices:');
		});

		it("--org naming another organization lists that organization's environments", async () => {
			orgs = [ACME, GLOBEX];
			await poli('--org', 'globex');
			expect(errors).toEqual([]);
			expect(logs).toEqual([
				'Environments of globex:',
				'',
				'  ENVIRONMENT  PROTECTED  READ-ONLY  PROJECTS',
				'  sandbox      no         no         0',
			]);
		});

		it('refuses an organization the account does not belong to', async () => {
			orgs = [GLOBEX];
			await poli();
			expect(errors.join('\n')).toContain('Organization "acme" not found. Available: globex');
			expect(process.exitCode).toBe(ExitCode.INCONSISTENT);
			expect(logs).toEqual([]);
		});
	});

	describe('outside a linked folder', () => {
		it("lists the only organization's environments with their project count", async () => {
			await poli();

			expect(errors).toEqual([]);
			expect(process.exitCode).toBeUndefined();
			expect(logs).toEqual([
				'Environments of acme:',
				'',
				'  ENVIRONMENT  PROTECTED  READ-ONLY  PROJECTS',
				'  sandbox      no         no         3',
				'  live         yes        no         2',
				'  staging      no         yes        0',
			]);
			expect(requestedUrls()).toEqual([
				`${API_URL}/api/organizations`,
				`${API_URL}/api/organizations/org_1/environments`,
			]);
		});

		it('treats a poli-page.json without cloud as not linked', async () => {
			await linkProject({ project: { name: 'Invoices' }, templates: [] });
			await poli();
			expect(logs[0]).toBe('Environments of acme:');
		});

		it('prints the API answer as JSON with --json', async () => {
			await poli('--json');
			expect(JSON.parse(logs.join('\n'))).toEqual(ORG_ENVIRONMENTS);
		});

		it('--org picks the organization among several', async () => {
			orgs = [ACME, GLOBEX];
			await poli('--org', 'acme');
			expect(logs[0]).toBe('Environments of acme:');
			expect(requestedUrls()).toContain(`${API_URL}/api/organizations/org_1/environments`);
		});

		it('several organizations without --org: exit 2, listing the slugs', async () => {
			orgs = [ACME, GLOBEX];
			await poli();
			expect(process.exitCode).toBe(ExitCode.INVALID_USAGE);
			expect(errors.join('\n')).toBe(
				'You belong to several organizations: acme, globex. Pick one with --org <slug>.'
			);
			expect(logs).toEqual([]);
			expect(requestedUrls()).toEqual([`${API_URL}/api/organizations`]);
		});

		it('an unknown --org: exit 2, listing the slugs', async () => {
			orgs = [ACME, GLOBEX];
			await poli('--org', 'initech');
			expect(process.exitCode).toBe(ExitCode.INVALID_USAGE);
			expect(errors.join('\n')).toBe(
				'Organization "initech" not found. Available: acme, globex'
			);
			expect(requestedUrls()).toEqual([`${API_URL}/api/organizations`]);
		});

		it('an account without an organization: says so, exit 1', async () => {
			orgs = [];
			await poli();
			expect(process.exitCode).toBe(ExitCode.INCONSISTENT);
			expect(errors.join('\n')).toBe(
				'Your account has no organization yet. Create one in the dashboard.'
			);
			expect(logs).toEqual([]);
		});
	});

	describe('an API failure', () => {
		const requests = [
			{ linked: false, failing: '/api/organizations' },
			{ linked: false, failing: '/api/organizations/org_1/environments' },
			{ linked: true, failing: '/api/organizations' },
			{ linked: true, failing: '/api/organizations/org_1/projects/proj_1/environments' },
		];
		const failures = [
			{
				status: 403,
				body: { error: 'NOT_A_MEMBER', requestId: 'req_1' },
				stderr: '403 NOT_A_MEMBER',
				exitCode: ExitCode.NOT_AUTHORIZED,
			},
			{
				status: 500,
				body: {
					error: 'INTERNAL_ERROR',
					detail: 'Database unavailable',
					requestId: 'req_1',
				},
				stderr: 'Database unavailable',
				exitCode: ExitCode.NETWORK_OR_API_ERROR,
			},
		];

		for (const { linked, failing } of requests) {
			for (const { status, body, stderr, exitCode } of failures) {
				it(`${status} on ${failing} (${linked ? 'linked' : 'unlinked'}): exit ${exitCode}, nothing on stdout`, async () => {
					if (linked) await linkProject();
					const answer = fetchMock.getMockImplementation()!;
					fetchMock.mockImplementation(async (url: string) =>
						url === `${API_URL}${failing}` ? jsonResponse(status, body) : answer(url)
					);
					await poli();
					expect(requestedUrls()).toContain(`${API_URL}${failing}`);
					expect(process.exitCode).toBe(exitCode);
					expect(errors).toEqual([stderr]);
					expect(logs).toEqual([]);
				});
			}
		}
	});

	it('a poli-page.json that is not valid JSON is reported, not read as unlinked', async () => {
		await writeFile(join(projectDir, MANIFEST_FILENAME), '{ not json');
		await poli();
		expect(process.exitCode).toBe(ExitCode.INCONSISTENT);
		expect(errors.join('\n')).toMatch(/JSON/);
		expect(logs).toEqual([]);
	});

	it('without a session: exit 4 with "Run poli login", and no API call', async () => {
		await rm(join(fakeHome, '.polipage'), { recursive: true, force: true });
		await linkProject();
		await poli();
		expect(process.exitCode).toBe(ExitCode.NOT_AUTHENTICATED);
		expect(errors.join('\n')).toBe('Not logged in. Run "poli login" first.');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
