import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProgram } from '../../src/program.js';
import { writeCredentials } from '../../src/credentials.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));
vi.mock('@inquirer/prompts', () => ({ confirm: confirmMock }));

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
				cloud: { orgSlug: 'acme', orgId: 'org_1', projectSlug: 'demo', projectId: 'proj_1' },
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
					return jsonResponse([{ id: 'org_1', name: 'Acme', slug: 'acme' }]);
				}
				if (url === `${API_URL}/api/organizations/org_1/projects`) {
					return jsonResponse([{ id: 'proj_1', name: 'Demo', slug: 'demo' }]);
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
