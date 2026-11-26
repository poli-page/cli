import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProgram } from '../../src/program.js';
import { writeCredentials } from '../../src/credentials.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';

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
		vi.stubEnv('HOME', fakeHome);
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
		vi.stubEnv('HOME', fakeHome);
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
