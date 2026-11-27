import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProgram } from '../../src/program.js';
import { writeCredentials } from '../../src/credentials.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';
import { stubHome } from '../helpers/fake-home.js';

const { confirmMock, selectMock } = vi.hoisted(() => ({
	confirmMock: vi.fn(),
	selectMock: vi.fn(),
}));
vi.mock('@inquirer/prompts', () => ({ confirm: confirmMock, select: selectMock }));

const API_URL = 'https://api.poli.page';

// `poli dev` and `poli watch` ask about an unconfirmed link only when someone can answer.
describe('poli dev / poli watch on a folder whose link is not confirmed', () => {
	let projectDir: string;
	let fakeHome: string;
	let savedExitCode: typeof process.exitCode;
	let savedTTY: { stdin: boolean | undefined; stdout: boolean | undefined };

	function jsonResponse(body: unknown) {
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), 'poli-dev-link-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-dev-link-home-'));
		await writeFile(
			join(projectDir, MANIFEST_FILENAME),
			JSON.stringify({
				project: { name: 'demo' },
				cloud: {
					orgSlug: 'acme',
					orgId: '0e89d99e-1516-4b48-baa1-f49e660ad1c1',
					projectSlug: 'demo',
					projectId: '8274f64d-4ea2-4f96-b596-5727a7b17268',
				},
				templates: [],
			})
		);
		await writeCredentials(
			{ session: 'sess', user: { id: 'u', name: 'X', email: 'x@x.com' }, orgs: {} },
			fakeHome
		);
		stubHome(fakeHome);
		vi.stubEnv('POLI_API_URL', API_URL);
		vi.stubEnv('POLI_PAGE_API_KEY', '');
		vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === `${API_URL}/api/organizations`) {
					return jsonResponse([
						{ id: '0e89d99e-1516-4b48-baa1-f49e660ad1c1', name: 'Acme', slug: 'acme' },
					]);
				}
				if (
					url ===
					`${API_URL}/api/organizations/0e89d99e-1516-4b48-baa1-f49e660ad1c1/projects`
				) {
					return jsonResponse([
						{ id: '8274f64d-4ea2-4f96-b596-5727a7b17268', name: 'Demo', slug: 'demo' },
					]);
				}
				return new Response('unexpected', { status: 500 });
			})
		);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		savedExitCode = process.exitCode;
		process.exitCode = undefined;
		savedTTY = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
		confirmMock.mockReset();
	});

	afterEach(async () => {
		process.stdin.isTTY = savedTTY.stdin as true;
		process.stdout.isTTY = savedTTY.stdout as true;
		process.exitCode = savedExitCode;
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		await rm(projectDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	function poliDev() {
		return createProgram().parseAsync(['dev', '--no-open'], { from: 'user' });
	}

	function poliWatch() {
		return createProgram().parseAsync(['watch'], { from: 'user' });
	}

	it('asks in a terminal, naming the organization and project', async () => {
		process.stdin.isTTY = true;
		process.stdout.isTTY = true;
		confirmMock.mockResolvedValue(false);

		await poliDev();

		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(confirmMock.mock.calls[0][0].message).toMatch(
			/project "Demo" \(demo\) of organization "Acme" \(acme\)/
		);
		expect(process.exitCode).toBe(1);
	});

	it('refuses with exit 2, without asking, when stdin is not a TTY', async () => {
		process.stdin.isTTY = false as true;
		process.stdout.isTTY = true;

		await poliDev();

		expect(confirmMock).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(2);
	});

	it('refuses with exit 2, without asking, when stdout is piped', async () => {
		process.stdin.isTTY = true;
		process.stdout.isTTY = false as true;

		await poliDev();

		expect(confirmMock).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(2);
	});

	it('watch asks in a terminal, and stops when the answer is no', async () => {
		process.stdin.isTTY = true;
		process.stdout.isTTY = true;
		confirmMock.mockResolvedValue(false);

		await poliWatch();

		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(process.exitCode).toBe(1);
	});

	it('watch refuses with exit 2, without asking, when stdin is not a TTY', async () => {
		process.stdin.isTTY = false as true;
		process.stdout.isTTY = true;

		await poliWatch();

		expect(confirmMock).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(2);
	});
});

// `poli link` adopts a project of the same slug only when the user says so.
describe('poli link when the organization already has the project', () => {
	let projectDir: string;
	let fakeHome: string;
	let savedExitCode: typeof process.exitCode;
	let savedTTY: { stdin: boolean | undefined; stdout: boolean | undefined };
	let createCalled: boolean;

	function jsonResponse(body: unknown) {
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), 'poli-link-existing-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-link-existing-home-'));
		await writeFile(
			join(projectDir, MANIFEST_FILENAME),
			JSON.stringify({ project: { name: 'demo' }, templates: [] })
		);
		await writeCredentials(
			{ session: 'sess', user: { id: 'u', name: 'X', email: 'x@x.com' }, orgs: {} },
			fakeHome
		);
		stubHome(fakeHome);
		vi.stubEnv('POLI_API_URL', API_URL);
		vi.stubEnv('POLI_PAGE_API_KEY', '');
		vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
		createCalled = false;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url === `${API_URL}/api/organizations`) {
					return jsonResponse([
						{ id: '0e89d99e-1516-4b48-baa1-f49e660ad1c1', name: 'Acme', slug: 'acme' },
					]);
				}
				if (
					url ===
					`${API_URL}/api/organizations/0e89d99e-1516-4b48-baa1-f49e660ad1c1/projects`
				) {
					if (init?.method === 'POST') {
						createCalled = true;
						return jsonResponse({ id: 'proj_new' });
					}
					return jsonResponse([
						{ id: '8274f64d-4ea2-4f96-b596-5727a7b17268', name: 'Demo', slug: 'demo' },
					]);
				}
				return new Response('unexpected', { status: 500 });
			})
		);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		savedExitCode = process.exitCode;
		process.exitCode = undefined;
		savedTTY = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
		confirmMock.mockReset();
		selectMock.mockReset();
		selectMock.mockResolvedValue('acme');
	});

	afterEach(async () => {
		process.stdin.isTTY = savedTTY.stdin as true;
		process.stdout.isTTY = savedTTY.stdout as true;
		process.exitCode = savedExitCode;
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		await rm(projectDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	function poliLink(...args: string[]) {
		return createProgram().parseAsync(['link', ...args], { from: 'user' });
	}

	async function readCloud() {
		const manifest = JSON.parse(await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8'));
		return manifest.cloud;
	}

	it('asks in a terminal, and leaves the folder unlinked on no', async () => {
		process.stdin.isTTY = true;
		process.stdout.isTTY = true;
		confirmMock.mockResolvedValue(false);

		await poliLink();

		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(confirmMock.mock.calls[0][0].message).toMatch(
			/project "Demo" \(demo\) of organization "Acme" \(acme\)/
		);
		expect(process.exitCode).toBe(1);
		expect(await readCloud()).toBeUndefined();
		expect(createCalled).toBe(false);
	});

	it('shows server names on one line in the organization picker and the question', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url === `${API_URL}/api/organizations`) {
					return jsonResponse([
						{
							id: '0e89d99e-1516-4b48-baa1-f49e660ad1c1',
							name: 'Ac\nme\u001b[2J',
							slug: 'ac\rme',
						},
						{
							id: '5b1f1c1e-9a43-4a8e-bb3a-0f6c2d9e7a10',
							name: 'Globex',
							slug: 'globex',
						},
					]);
				}
				return jsonResponse([
					{
						id: '8274f64d-4ea2-4f96-b596-5727a7b17268',
						name: 'De\nmo\u0007',
						slug: 'demo',
					},
				]);
			})
		);
		process.stdin.isTTY = true;
		process.stdout.isTTY = true;
		selectMock.mockResolvedValue('ac\rme');
		confirmMock.mockResolvedValue(false);

		await poliLink();

		expect(selectMock.mock.calls[0][0].choices).toEqual([
			{ name: 'Ac me [2J (ac me)', value: 'ac\rme' },
			{ name: 'Globex (globex)', value: 'globex' },
		]);
		expect(confirmMock.mock.calls[0][0].message).toMatch(
			/^Link this folder to the existing project "De mo" \(demo\) of organization "Ac me \[2J" \(ac me\)\? [^\p{Cc}]+$/u
		);
	});

	it('names a server slug with control characters on one line once linked', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url === `${API_URL}/api/organizations`) {
					return jsonResponse([
						{
							id: '0e89d99e-1516-4b48-baa1-f49e660ad1c1',
							name: 'Acme',
							slug: 'ac\nme\u001b[2J',
						},
					]);
				}
				return jsonResponse(init?.method === 'POST' ? { id: 'proj_new' } : []);
			})
		);
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		selectMock.mockResolvedValue('ac\nme\u001b[2J');

		await poliLink();

		expect(process.exitCode).toBeUndefined();
		const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
		expect(written).toContain('Project linked to ac me [2J');
		expect(written).not.toMatch(/ac\nme|\u001b\[2J/);
	});

	it('links on yes', async () => {
		process.stdin.isTTY = true;
		process.stdout.isTTY = true;
		confirmMock.mockResolvedValue(true);

		await poliLink();

		expect(process.exitCode).toBeUndefined();
		expect((await readCloud()).projectId).toBe('8274f64d-4ea2-4f96-b596-5727a7b17268');
	});

	it.each([
		['stdin', () => (process.stdin.isTTY = false as true)],
		['stdout', () => (process.stdout.isTTY = false as true)],
	])('refuses with exit 2, without asking or writing, when %s is not a TTY', async (_, pipe) => {
		process.stdin.isTTY = true;
		process.stdout.isTTY = true;
		pipe();

		await poliLink();

		expect(confirmMock).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(2);
		expect(await readCloud()).toBeUndefined();
	});

	it('links without asking with --existing', async () => {
		process.stdin.isTTY = false as true;
		process.stdout.isTTY = false as true;

		await poliLink('--existing');

		expect(confirmMock).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
		expect((await readCloud()).projectId).toBe('8274f64d-4ea2-4f96-b596-5727a7b17268');
		expect(createCalled).toBe(false);
	});
});

// `poli link` picks the organization from `--org`, the only one, or the prompt.
describe('poli link choosing the organization', () => {
	const ACME = { id: '0e89d99e-1516-4b48-baa1-f49e660ad1c1', name: 'Acme', slug: 'acme' };
	const GLOBEX = { id: '5b1f1c1e-9a43-4a8e-bb3a-0f6c2d9e7a10', name: 'Globex', slug: 'globex' };
	let projectDir: string;
	let fakeHome: string;
	let savedExitCode: typeof process.exitCode;
	let savedTTY: { stdin: boolean | undefined; stdout: boolean | undefined };
	let errors: string[];

	function jsonResponse(body: unknown) {
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	function serveOrganizations(orgs: (typeof ACME)[]) {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url === `${API_URL}/api/organizations`) return jsonResponse(orgs);
				const projectsOf = orgs.map((o) => `${API_URL}/api/organizations/${o.id}/projects`);
				if (projectsOf.includes(url)) {
					const created = { id: '8274f64d-4ea2-4f96-b596-5727a7b17268' };
					return jsonResponse(init?.method === 'POST' ? created : []);
				}
				return new Response('unexpected', { status: 500 });
			})
		);
	}

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), 'poli-link-org-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-link-org-home-'));
		await writeFile(
			join(projectDir, MANIFEST_FILENAME),
			JSON.stringify({ project: { name: 'demo' }, templates: [] })
		);
		await writeCredentials(
			{ session: 'sess', user: { id: 'u', name: 'X', email: 'x@x.com' }, orgs: {} },
			fakeHome
		);
		stubHome(fakeHome);
		vi.stubEnv('POLI_API_URL', API_URL);
		vi.stubEnv('POLI_PAGE_API_KEY', '');
		vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
		serveOrganizations([ACME, GLOBEX]);
		errors = [];
		vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
			errors.push(String(msg));
		});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
			errors.push(String(chunk));
			return true;
		});
		savedExitCode = process.exitCode;
		process.exitCode = undefined;
		savedTTY = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
		process.stdin.isTTY = false as true;
		process.stdout.isTTY = false as true;
		confirmMock.mockReset();
		selectMock.mockReset();
	});

	afterEach(async () => {
		process.stdin.isTTY = savedTTY.stdin as true;
		process.stdout.isTTY = savedTTY.stdout as true;
		process.exitCode = savedExitCode;
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		await rm(projectDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	function poliLink(...args: string[]) {
		return createProgram().parseAsync(['link', ...args], { from: 'user' });
	}

	async function readCloud() {
		const manifest = JSON.parse(await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8'));
		return manifest.cloud;
	}

	it('links to the --org organization without a prompt', async () => {
		await poliLink('--org', 'globex');

		expect(selectMock).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
		expect(await readCloud()).toMatchObject({ orgSlug: 'globex', orgId: GLOBEX.id });
	});

	it('does not prompt with --org in a terminal either', async () => {
		process.stdin.isTTY = true;
		process.stdout.isTTY = true;

		await poliLink('--org', 'acme');

		expect(selectMock).not.toHaveBeenCalled();
		expect((await readCloud()).orgSlug).toBe('acme');
	});

	it('refuses an unknown --org with exit 2, listing the organizations, and writes nothing', async () => {
		await poliLink('--org', 'initech');

		expect(selectMock).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(2);
		expect(errors.join('')).toContain(
			'Organization "initech" not found. Available: acme, globex'
		);
		expect(await readCloud()).toBeUndefined();
	});

	it('refuses an empty --org with exit 2 instead of picking the only organization', async () => {
		serveOrganizations([GLOBEX]);

		await poliLink('--org', '');

		expect(process.exitCode).toBe(2);
		expect(errors.join('')).toContain('Organization "" not found. Available: globex');
		expect(await readCloud()).toBeUndefined();
	});

	it('uses the only organization without a prompt', async () => {
		serveOrganizations([GLOBEX]);

		await poliLink();

		expect(selectMock).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
		expect((await readCloud()).orgSlug).toBe('globex');
	});

	it.each([
		['stdin', () => (process.stdout.isTTY = true)],
		['stdout', () => (process.stdin.isTTY = true)],
	])(
		'refuses with exit 2, listing the slugs, with several organizations when %s is not a TTY',
		async (_, otherIsTTY) => {
			otherIsTTY();

			await poliLink();

			expect(selectMock).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(2);
			expect(errors.join('')).toContain(
				'You belong to several organizations (acme, globex). Pass `--org <slug>` to choose one.'
			);
			expect(await readCloud()).toBeUndefined();
		}
	);

	it('names server slugs on one line when it refuses', async () => {
		serveOrganizations([ACME, { ...GLOBEX, slug: 'glo\nbex\u001b[2J' }]);

		await poliLink();

		const written = errors.join('');
		expect(written).toContain('(acme, glo bex [2J)');
		expect(written).not.toMatch(/glo\nbex|\u001b\[2J/);
	});

	it('asks in a terminal with several organizations', async () => {
		process.stdin.isTTY = true;
		process.stdout.isTTY = true;
		selectMock.mockResolvedValue('globex');

		await poliLink();

		expect(selectMock).toHaveBeenCalledTimes(1);
		expect(selectMock.mock.calls[0][0].choices.map((c: { value: string }) => c.value)).toEqual([
			'acme',
			'globex',
		]);
		expect(process.exitCode).toBeUndefined();
		expect((await readCloud()).orgSlug).toBe('globex');
	});
});
