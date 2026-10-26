import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeUnlinked, executeInitStarter } from '../../src/commands/init.js';
import { createProgram } from '../../src/program.js';
import { writeCredentials } from '../../src/credentials.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';
import type { ApiClient } from '../../src/api-client.js';
import type { Fetcher } from '../../src/template-importer.js';
import { createFakeApiClient } from '../helpers/fake-api-client.js';

const STARTER_MANIFEST = {
	project: { name: 'getting-started', version: '1.0.0', description: 'The starter' },
	engine: { paginationOptions: { orphanThreshold: 0.08 } },
	templates: [{ name: 'welcome', template: 'welcome.html', mock: 'welcome.json' }],
	fonts: [{ family: 'Inter', src: 'fonts/inter-400.woff2', weight: 400, style: 'normal' }],
	cloud: { orgSlug: 'someone-else', projectId: 'proj_foreign' },
};

// Files of `getting-started/` in the source repo, keyed by repo path.
const SOURCE_FILES: Record<string, string> = {
	'getting-started/poli-page.json': JSON.stringify(STARTER_MANIFEST),
	'getting-started/tailwind.css': "@import 'tailwindcss';\n",
	'getting-started/.gitignore': 'output/\n',
	'getting-started/assets/fonts/inter-400.woff2': 'FONTDATA',
	'getting-started/assets/images/logo.svg': '<svg/>',
	'getting-started/templates/welcome/welcome.html': '<h1>{{ title }}</h1>',
	'getting-started/templates/welcome/welcome.json': '{"title":"Hi"}',
	// Import metadata of the templates repo, not part of a project.
	'getting-started/templates/welcome/manifest.json': '{}',
	'getting-started/templates/welcome/tailwind-additions.css': '/* additions */',
	'showcase/templates/invoice/invoice.html': '<div/>',
};

const TREE_URL = 'https://api.github.com/repos/poli-page/templates/git/trees/main?recursive=1';

function makeFetcher(requested: string[]): Fetcher {
	return async (url: string) => {
		requested.push(url);
		if (url === TREE_URL) {
			const tree = [
				{ path: 'getting-started', type: 'tree' },
				...Object.keys(SOURCE_FILES).map((path) => ({ path, type: 'blob' })),
			];
			return new Response(JSON.stringify({ tree, truncated: false }), { status: 200 });
		}
		const m = url.match(
			/^https:\/\/raw\.githubusercontent\.com\/poli-page\/templates\/main\/(.+)$/
		);
		const content = m ? SOURCE_FILES[m[1]] : undefined;
		if (content === undefined) return new Response('not found', { status: 404 });
		return new Response(content, { status: 200 });
	};
}

// Only the two read routes the link step needs; any other API call
// (pull, download, create…) fails the test.
function makeClient(
	projects: Array<{ id: string; name: string; slug: string }>,
	orgs = [{ id: 'org_1', name: 'Acme', slug: 'acme' }],
	calls: string[] = []
): ApiClient {
	return createFakeApiClient({
		getOrganizations: async () => {
			calls.push('getOrganizations');
			return orgs;
		},
		listProjects: async () => {
			calls.push('listProjects');
			return projects;
		},
	});
}

describe('poli init --starter', () => {
	let tempDir: string;
	let fakeHome: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-init-starter-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-home-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	async function login() {
		await writeCredentials(
			{ session: 'sess', user: { id: 'u', name: 'X', email: 'x@x.com' }, orgs: {} },
			fakeHome
		);
	}

	async function readWrittenManifest(dir: string) {
		return JSON.parse(await readFile(join(dir, MANIFEST_FILENAME), 'utf-8'));
	}

	it('writes the full starter into ./getting-started by default', async () => {
		const result = await executeInitStarter('getting-started', undefined, {
			cwd: tempDir,
			homeDir: fakeHome,
			fetcher: makeFetcher([]),
			apiClient: makeClient([]),
		});

		const dir = join(tempDir, 'getting-started');
		expect(result.projectDir).toBe(dir);
		expect(await readFile(join(dir, 'tailwind.css'), 'utf-8')).toContain('tailwindcss');
		expect(await readFile(join(dir, '.gitignore'), 'utf-8')).toBe('output/\n');
		expect(await readFile(join(dir, 'assets/fonts/inter-400.woff2'), 'utf-8')).toBe('FONTDATA');
		expect(await readFile(join(dir, 'assets/images/logo.svg'), 'utf-8')).toBe('<svg/>');
		expect(await readFile(join(dir, 'templates/welcome/welcome.html'), 'utf-8')).toBe(
			'<h1>{{ title }}</h1>'
		);
		expect(await readFile(join(dir, 'templates/welcome/welcome.json'), 'utf-8')).toBe(
			'{"title":"Hi"}'
		);
		await expect(stat(join(dir, 'templates/welcome/manifest.json'))).rejects.toThrow();
		await expect(stat(join(dir, 'templates/welcome/tailwind-additions.css'))).rejects.toThrow();
		await expect(stat(join(dir, 'templates/invoice'))).rejects.toThrow();
	});

	it('writes into the given directory', async () => {
		const result = await executeInitStarter('getting-started', 'my-start', {
			cwd: tempDir,
			homeDir: fakeHome,
			fetcher: makeFetcher([]),
			apiClient: makeClient([]),
		});
		expect(result.projectDir).toBe(join(tempDir, 'my-start'));
		await stat(join(tempDir, 'my-start', 'templates/welcome/welcome.html'));
	});

	it("links to the org's existing getting-started project when logged in", async () => {
		await login();
		const calls: string[] = [];
		const result = await executeInitStarter('getting-started', undefined, {
			cwd: tempDir,
			homeDir: fakeHome,
			fetcher: makeFetcher([]),
			apiClient: makeClient(
				[
					{ id: 'proj_x', name: 'Invoices', slug: 'invoices' },
					{ id: 'proj_gs', name: 'Getting started', slug: 'getting-started' },
				],
				undefined,
				calls
			),
		});

		expect(result.link).toEqual({ status: 'linked', orgSlug: 'acme' });
		const manifest = await readWrittenManifest(result.projectDir);
		expect(manifest.cloud).toEqual({
			orgSlug: 'acme',
			orgId: 'org_1',
			projectSlug: 'getting-started',
			projectId: 'proj_gs',
		});
		expect(manifest.project).toEqual({ name: 'getting-started', description: 'The starter' });
		expect(manifest.templates).toEqual(STARTER_MANIFEST.templates);
		expect(manifest.fonts).toEqual(STARTER_MANIFEST.fonts);
		expect(new Set(calls)).toEqual(new Set(['getOrganizations', 'listProjects']));
	});

	it('writes the starter unlinked when logged out', async () => {
		const calls: string[] = [];
		const result = await executeInitStarter('getting-started', undefined, {
			cwd: tempDir,
			homeDir: fakeHome,
			fetcher: makeFetcher([]),
			apiClient: makeClient([], undefined, calls),
		});

		expect(result.link).toEqual({ status: 'unlinked', reason: 'not-logged-in' });
		const manifest = await readWrittenManifest(result.projectDir);
		expect(manifest.cloud).toBeUndefined();
		expect(manifest.project.version).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it('writes the starter unlinked when the org has no getting-started project', async () => {
		await login();
		const result = await executeInitStarter('getting-started', undefined, {
			cwd: tempDir,
			homeDir: fakeHome,
			fetcher: makeFetcher([]),
			apiClient: makeClient([{ id: 'proj_x', name: 'Invoices', slug: 'invoices' }]),
		});

		expect(result.link).toEqual({ status: 'unlinked', reason: 'no-project', orgSlug: 'acme' });
		const manifest = await readWrittenManifest(result.projectDir);
		expect(manifest.cloud).toBeUndefined();
		expect(manifest.project.version).toBeUndefined();
	});

	it('uses --org when the user belongs to several organizations', async () => {
		await login();
		const orgs = [
			{ id: 'org_1', name: 'Acme', slug: 'acme' },
			{ id: 'org_2', name: 'Beta', slug: 'beta' },
		];
		const result = await executeInitStarter('getting-started', undefined, {
			cwd: tempDir,
			homeDir: fakeHome,
			org: 'beta',
			fetcher: makeFetcher([]),
			apiClient: makeClient([{ id: 'proj_gs', name: 'GS', slug: 'getting-started' }], orgs),
		});

		expect(result.link).toEqual({ status: 'linked', orgSlug: 'beta' });
		expect((await readWrittenManifest(result.projectDir)).cloud.orgId).toBe('org_2');
	});

	it('asks which organization to use when there are several and no --org', async () => {
		await login();
		const orgs = [
			{ id: 'org_1', name: 'Acme', slug: 'acme' },
			{ id: 'org_2', name: 'Beta', slug: 'beta' },
		];
		const offered: string[] = [];
		const result = await executeInitStarter('getting-started', undefined, {
			cwd: tempDir,
			homeDir: fakeHome,
			fetcher: makeFetcher([]),
			apiClient: makeClient([{ id: 'proj_gs', name: 'GS', slug: 'getting-started' }], orgs),
			selectOrg: async (choices) => {
				offered.push(...choices.map((o) => o.slug));
				return 'beta';
			},
		});

		expect(offered).toEqual(['acme', 'beta']);
		expect(result.link).toEqual({ status: 'linked', orgSlug: 'beta' });
	});

	it('stays unlinked when there are several organizations and nobody to ask', async () => {
		await login();
		const orgs = [
			{ id: 'org_1', name: 'Acme', slug: 'acme' },
			{ id: 'org_2', name: 'Beta', slug: 'beta' },
		];
		const result = await executeInitStarter('getting-started', undefined, {
			cwd: tempDir,
			homeDir: fakeHome,
			fetcher: makeFetcher([]),
			apiClient: makeClient([{ id: 'proj_gs', name: 'GS', slug: 'getting-started' }], orgs),
		});

		expect(result.link).toEqual({ status: 'unlinked', reason: 'several-orgs' });
		expect((await readWrittenManifest(result.projectDir)).cloud).toBeUndefined();
	});

	it('rejects an unknown --org', async () => {
		await login();
		await expect(
			executeInitStarter('getting-started', undefined, {
				cwd: tempDir,
				homeDir: fakeHome,
				org: 'nope',
				fetcher: makeFetcher([]),
				apiClient: makeClient([]),
			})
		).rejects.toThrow(/Organization "nope" not found/);
	});

	it('fetches only from the public templates repo', async () => {
		await login();
		const requested: string[] = [];
		await executeInitStarter('getting-started', undefined, {
			cwd: tempDir,
			homeDir: fakeHome,
			noCache: true,
			fetcher: makeFetcher(requested),
			apiClient: makeClient([{ id: 'proj_gs', name: 'GS', slug: 'getting-started' }]),
		});

		expect(requested.length).toBeGreaterThan(1);
		for (const url of requested) {
			expect(
				url === TREE_URL ||
					url.startsWith(
						'https://raw.githubusercontent.com/poli-page/templates/main/getting-started/'
					)
			).toBe(true);
		}
	});

	it('refuses a non-empty target directory', async () => {
		const dir = join(tempDir, 'getting-started');
		await mkdir(dir);
		await writeFile(join(dir, 'keep.txt'), 'mine');

		await expect(
			executeInitStarter('getting-started', undefined, {
				cwd: tempDir,
				homeDir: fakeHome,
				fetcher: makeFetcher([]),
				apiClient: makeClient([]),
			})
		).rejects.toThrow(/not empty.*--force/);
		expect(await readFile(join(dir, 'keep.txt'), 'utf-8')).toBe('mine');
		await expect(stat(join(dir, MANIFEST_FILENAME))).rejects.toThrow();
	});

	it('writes into a non-empty target directory with --force', async () => {
		const dir = join(tempDir, 'getting-started');
		await mkdir(dir);
		await writeFile(join(dir, 'keep.txt'), 'mine');

		await executeInitStarter('getting-started', undefined, {
			cwd: tempDir,
			homeDir: fakeHome,
			force: true,
			fetcher: makeFetcher([]),
			apiClient: makeClient([]),
		});
		await stat(join(dir, MANIFEST_FILENAME));
	});

	it('accepts an existing empty target directory', async () => {
		await mkdir(join(tempDir, 'getting-started'));
		const result = await executeInitStarter('getting-started', undefined, {
			cwd: tempDir,
			homeDir: fakeHome,
			fetcher: makeFetcher([]),
			apiClient: makeClient([]),
		});
		await stat(join(result.projectDir, MANIFEST_FILENAME));
	});

	it('rejects a starter the source does not have', async () => {
		await expect(
			executeInitStarter('nope', undefined, {
				cwd: tempDir,
				homeDir: fakeHome,
				fetcher: makeFetcher([]),
				apiClient: makeClient([]),
			})
		).rejects.toThrow(/Unknown starter "nope"/);
		await expect(stat(join(tempDir, 'nope'))).rejects.toThrow();
	});

	it.each(['../getting-started', 'getting-started/templates', '.', ''])(
		'rejects %j: a starter is one top-level folder of the source',
		async (starter) => {
			const requested: string[] = [];
			await expect(
				executeInitStarter(starter, join(tempDir, 'out'), {
					cwd: tempDir,
					homeDir: fakeHome,
					fetcher: makeFetcher(requested),
					apiClient: makeClient([]),
				})
			).rejects.toThrow(/Invalid starter name/);
			expect(requested).toEqual([]);
			await expect(stat(join(tempDir, 'out'))).rejects.toThrow();
		}
	);
});

describe('poli init --starter: command output', () => {
	it('says how to link for each unlinked reason', () => {
		expect(
			describeUnlinked({ status: 'unlinked', reason: 'not-logged-in' }, 'getting-started')
		).toBe(
			'Not linked: you are not logged in. Run `poli login`, then `poli link` in the project.'
		);
		expect(describeUnlinked({ status: 'unlinked', reason: 'no-org' }, 'getting-started')).toBe(
			'Not linked: your account has no organization yet. Create one in the dashboard, then run `poli link`.'
		);
		expect(
			describeUnlinked({ status: 'unlinked', reason: 'several-orgs' }, 'getting-started')
		).toBe(
			'Not linked: you belong to several organizations. Re-run with `--org <slug>`, or run `poli link` in the project.'
		);
		expect(
			describeUnlinked(
				{ status: 'unlinked', reason: 'no-project', orgSlug: 'acme' },
				'getting-started'
			)
		).toBe(
			'Not linked: organization "acme" has no "getting-started" project. Run `poli link` in the project to link it.'
		);
	});

	describe('usage errors', () => {
		let savedExitCode: typeof process.exitCode;
		let errors: string[];

		beforeEach(() => {
			savedExitCode = process.exitCode;
			process.exitCode = undefined;
			errors = [];
			vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
				errors.push(String(msg));
			});
		});

		afterEach(() => {
			process.exitCode = savedExitCode;
			vi.restoreAllMocks();
		});

		it('refuses --starter with --with-template (exit 2)', async () => {
			await createProgram().parseAsync(
				['init', '--starter', 'getting-started', '--with-template', 'showcase/invoice'],
				{ from: 'user' }
			);
			expect(process.exitCode).toBe(2);
			expect(errors.join('\n')).toContain(
				'--starter cannot be combined with --with-template'
			);
		});

		it('refuses a bare `poli init` without a name (exit 2)', async () => {
			await createProgram().parseAsync(['init'], { from: 'user' });
			expect(process.exitCode).toBe(2);
			expect(errors.join('\n')).toContain('Missing project name');
		});
	});

	describe('printed result', () => {
		let tempDir: string;
		let fakeHome: string;
		let logs: string[];

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), 'poli-init-starter-json-'));
			fakeHome = await mkdtemp(join(tmpdir(), 'poli-home-'));
			vi.stubEnv('HOME', fakeHome);
			vi.stubGlobal('fetch', makeFetcher([]));
			logs = [];
			vi.spyOn(console, 'log').mockImplementation((msg: unknown = '') => {
				logs.push(String(msg));
			});
		});

		afterEach(async () => {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
			await rm(tempDir, { recursive: true, force: true });
			await rm(fakeHome, { recursive: true, force: true });
		});

		it('prints the result as JSON', async () => {
			const dir = join(tempDir, 'gs');
			await createProgram().parseAsync(
				['init', '--starter', 'getting-started', dir, '--json', '--no-cache'],
				{ from: 'user' }
			);

			expect(JSON.parse(logs.join('\n'))).toEqual({
				starter: 'getting-started',
				projectDir: dir,
				link: { status: 'unlinked', reason: 'not-logged-in' },
			});
			await stat(join(dir, MANIFEST_FILENAME));
		});

		it('reports a failure on stderr with exit 1 and prints nothing on stdout', async () => {
			const dir = join(tempDir, 'gs');
			await mkdir(dir);
			await writeFile(join(dir, 'keep.txt'), 'mine');
			const errors: string[] = [];
			vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
				errors.push(String(msg));
			});
			const savedExitCode = process.exitCode;
			process.exitCode = undefined;
			try {
				await createProgram().parseAsync(
					['init', '--starter', 'getting-started', dir, '--no-cache'],
					{ from: 'user' }
				);
				expect(process.exitCode).toBe(1);
			} finally {
				process.exitCode = savedExitCode;
			}

			expect(errors.join('\n')).toContain('is not empty');
			expect(logs).toEqual([]);
		});

		it('ends with next steps that use registered commands', async () => {
			const savedTty = process.stdout.isTTY;
			Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
			try {
				await createProgram().parseAsync(
					['init', '--starter', 'getting-started', join(tempDir, 'gs'), '--no-cache'],
					{ from: 'user' }
				);
			} finally {
				Object.defineProperty(process.stdout, 'isTTY', {
					value: savedTty,
					configurable: true,
				});
			}

			const output = logs.join('\n');
			expect(output).toContain('poli watch');
			expect(output).toContain('poli push');
			expect(output).not.toContain('poli publish');
		});
	});
});
