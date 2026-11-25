import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTrustedApiOrigin } from '../src/api-origin.js';
import { createApiClient } from '../src/api-client.js';
import { resolveAuth } from '../src/auth.js';
import {
	getSessionToken,
	readCredentials,
	writeCredentials,
	type StoredCredentials,
} from '../src/credentials.js';
import { executeDeviceLogin } from '../src/commands/auth.js';
import { writeManifest } from '../src/manifest.js';
import { createProgram } from '../src/program.js';
import { ExitCode } from '../src/exit-codes.js';
import { createFakeApiClient } from './helpers/fake-api-client.js';
import { testApiKey } from './helpers/api-key.js';

interface Received {
	method?: string;
	url?: string;
	headers: IncomingHttpHeaders;
	body: string;
}

/** A local HTTP server that records every request it gets. */
async function listen(
	handler: (req: Received) => { status: number; headers?: Record<string, string>; body?: string } = () => ({
		status: 200,
		body: '{}',
	})
): Promise<{ origin: string; received: Received[]; close: () => Promise<void> }> {
	const received: Received[] = [];
	const server: Server = createServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			const entry = { method: req.method, url: req.url, headers: req.headers, body };
			received.push(entry);
			const reply = handler(entry);
			res.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers });
			res.end(reply.body ?? '');
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		received,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

const SESSION: StoredCredentials = {
	session: 'session-token-abc',
	user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
	orgs: { acme: {} },
};

const ME = {
	auth: { mode: 'session', keyType: null, environment: null, role: 'owner' },
	user: { id: 'user_1', email: 'xavier@test.com', name: 'Xavier', username: 'xavier' },
	key: null,
	org: { id: 'org_1', slug: 'acme', name: 'Acme', tier: 'free', lifecycleStatus: 'active' },
};

describe('assertTrustedApiOrigin', () => {
	it.each([
		['https://api.poli.page', 'https://api.poli.page'],
		['https://api.poli.page/', 'https://api.poli.page'],
		['https://api-develop.poli.page', 'https://api-develop.poli.page'],
		['https://poli.page', 'https://poli.page'],
	])('accepts %s', (url, origin) => {
		expect(assertTrustedApiOrigin(url, false)).toBe(origin);
	});

	it.each([
		'https://api.poli.page@evil.com',
		'https://evil.com\\@api.poli.page',
		'https://api.poli.page/v1',
		'https://api.poli.page/?x=1',
		'https://api.poli.page/#frag',
		'https://user:pw@api.poli.page',
		'http://api.poli.page',
		'https://evilpoli.page',
		'https://api.poli.page.evil.com',
		'https://evil.com',
		'not a url',
	])('refuses %s with exit code 2', (url) => {
		expect(() => assertTrustedApiOrigin(url, true)).toThrow(
			expect.objectContaining({ exitCode: ExitCode.INVALID_USAGE })
		);
	});

	it.each(['http://localhost:3000', 'http://127.0.0.1:9999'])(
		'accepts loopback %s only with the opt-in',
		(url) => {
			expect(() => assertTrustedApiOrigin(url, false)).toThrow(/--allow-insecure-api/);
			expect(assertTrustedApiOrigin(url, true)).toBe(url);
		}
	);
});

describe('createApiClient builds every request from the validated origin', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it('sends to the origin host, never to a concatenated string', async () => {
		const urls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				urls.push(url);
				return new Response(JSON.stringify(ME), { status: 200 });
			})
		);
		await createApiClient('https://api.poli.page/').getMe('Bearer t');
		expect(urls).toEqual(['https://api.poli.page/v1/me']);
		expect(new URL(urls[0]).host).toBe('api.poli.page');
	});

	it('refuses an untrusted POLI_API_URL before any request', () => {
		vi.stubEnv('POLI_API_URL', 'https://api.poli.page@evil.com');
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		expect(() => createApiClient()).toThrow(
			expect.objectContaining({ exitCode: ExitCode.INVALID_USAGE })
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('fails on a 307 to another origin, and the target receives nothing', async () => {
		vi.stubEnv('POLI_ALLOW_INSECURE_API', '1');
		const target = await listen();
		const api = await listen(() => ({
			status: 307,
			headers: { Location: `${target.origin}/api/auth/sign-in/email` },
		}));
		try {
			await expect(
				createApiClient(api.origin).signIn('x@test.com', 'hunter2')
			).rejects.toThrow(/redirect/i);
			expect(api.received).toHaveLength(1);
			expect(target.received).toHaveLength(0);
		} finally {
			await api.close();
			await target.close();
		}
	});
});

describe('the stored session is bound to the origin that issued it', () => {
	let fakeHome: string;

	beforeEach(async () => {
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-origin-'));
		vi.stubEnv('POLI_PAGE_API_KEY', '');
		vi.stubEnv('POLI_ALLOW_INSECURE_API', '1');
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(fakeHome, { recursive: true, force: true });
	});

	it('a file without origin is the default origin: refused elsewhere', async () => {
		await writeCredentials(SESSION, fakeHome);
		vi.stubEnv('POLI_API_URL', 'https://api-develop.poli.page');
		await expect(resolveAuth({ manifestOrgId: 'org_1', homeDir: fakeHome })).rejects.toThrow(
			expect.objectContaining({ exitCode: ExitCode.NOT_AUTHENTICATED })
		);
		vi.stubEnv('POLI_API_URL', '');
		await expect(resolveAuth({ manifestOrgId: 'org_1', homeDir: fakeHome })).resolves.toMatchObject({
			authorization: 'Bearer session-token-abc',
		});
	});

	it('a session for origin A is refused for origin B', async () => {
		await writeCredentials({ ...SESSION, origin: 'https://api-develop.poli.page' }, fakeHome);
		vi.stubEnv('POLI_API_URL', 'https://api.poli.page');
		await expect(resolveAuth({ manifestOrgId: 'org_1', homeDir: fakeHome })).rejects.toThrow(
			/issued by https:\/\/api-develop\.poli\.page/
		);
		vi.stubEnv('POLI_API_URL', 'https://api-develop.poli.page');
		await expect(resolveAuth({ manifestOrgId: 'org_1', homeDir: fakeHome })).resolves.toMatchObject({
			authorization: 'Bearer session-token-abc',
		});
	});

	it('getSessionToken refuses a session issued by another origin', async () => {
		await writeCredentials({ ...SESSION, origin: 'https://api-develop.poli.page' }, fakeHome);
		vi.stubEnv('POLI_API_URL', '');
		await expect(getSessionToken(fakeHome)).rejects.toThrow(
			expect.objectContaining({ exitCode: ExitCode.NOT_AUTHENTICATED })
		);
		vi.stubEnv('POLI_API_URL', 'https://api-develop.poli.page');
		await expect(getSessionToken(fakeHome)).resolves.toBe('session-token-abc');
	});

	it('poli login stores the issuing origin', async () => {
		vi.stubEnv('POLI_API_URL', 'https://api-develop.poli.page');
		const client = createFakeApiClient({
			deviceRequest: async () => ({
				deviceCode: 'dc',
				userCode: 'UC',
				verificationUrl: 'https://app.poli.page/device',
				expiresIn: 60,
				interval: 0,
			}),
			devicePoll: async () => ({
				status: 'confirmed',
				sessionToken: 'tok',
				user: SESSION.user,
			}),
			getOrganizations: async () => [],
		});
		await executeDeviceLogin({ apiClient: client, homeDir: fakeHome, openUrl: async () => {} });
		expect((await readCredentials(fakeHome))?.origin).toBe('https://api-develop.poli.page');
	});
});

describe('poli commands and the API URL', () => {
	let fakeHome: string;
	let projectDir: string;
	let errors: string[];
	let savedExitCode: typeof process.exitCode;
	let fetchedUrls: string[];

	beforeEach(async () => {
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-origin-home-'));
		projectDir = await mkdtemp(join(tmpdir(), 'poli-origin-proj-'));
		vi.stubEnv('HOME', fakeHome);
		vi.stubEnv('USERPROFILE', fakeHome);
		vi.stubEnv('POLI_API_URL', '');
		vi.stubEnv('POLI_ALLOW_INSECURE_API', '');
		vi.stubEnv('POLI_PAGE_API_KEY', '');
		vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
		errors = [];
		vi.spyOn(console, 'error').mockImplementation((msg: unknown = '') => {
			errors.push(String(msg));
		});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		savedExitCode = process.exitCode;
		process.exitCode = undefined;
		// Loopback goes to the real listener; anything else is answered here,
		// so no test reaches the network.
		fetchedUrls = [];
		const realFetch = globalThis.fetch;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				fetchedUrls.push(url);
				if (new URL(url).hostname === '127.0.0.1') return realFetch(url, init);
				return new Response(JSON.stringify(ME), { status: 200 });
			})
		);
	});

	afterEach(async () => {
		process.exitCode = savedExitCode;
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		await rm(fakeHome, { recursive: true, force: true });
		await rm(projectDir, { recursive: true, force: true });
	});

	function poli(...args: string[]) {
		return createProgram().exitOverride().parseAsync(args, { from: 'user' });
	}

	async function linkProject(apiUrl?: string) {
		await writeManifest(projectDir, {
			project: { name: 'p' },
			cloud: {
				orgSlug: 'acme',
				orgId: 'org_1',
				projectSlug: 'p',
				projectId: 'proj_1',
				...(apiUrl ? { apiUrl } : {}),
			},
		});
	}

	describe.each([
		['a session', () => writeCredentials(SESSION, fakeHome)],
		['POLI_PAGE_API_KEY', async () => vi.stubEnv('POLI_PAGE_API_KEY', testApiKey('live'))],
	])('with %s', (_label, setupAuth) => {
		it('ignores cloud.apiUrl from the manifest: nothing reaches it', async () => {
			const evil = await listen();
			try {
				await setupAuth();
				await linkProject(evil.origin);
				vi.stubEnv('POLI_ALLOW_INSECURE_API', '1');
				await poli('whoami');
				expect(evil.received).toHaveLength(0);
				expect(fetchedUrls).toEqual(['https://api.poli.page/v1/me']);
				expect(errors.join('\n')).toMatch(/Ignoring cloud\.apiUrl/);
			} finally {
				await evil.close();
			}
		});
	});

	it('honours cloud.apiUrl without a warning when it is the default URL', async () => {
		await writeCredentials(SESSION, fakeHome);
		await linkProject('https://api.poli.page');
		await poli('whoami');
		expect(fetchedUrls).toEqual(['https://api.poli.page/v1/me']);
		expect(errors).toEqual([]);
	});

	it('honours cloud.apiUrl when it equals the stored URL', async () => {
		await writeCredentials(
			{ ...SESSION, apiUrl: 'https://api-develop.poli.page', origin: 'https://api-develop.poli.page' },
			fakeHome
		);
		await linkProject('https://api-develop.poli.page');
		await poli('whoami');
		expect(fetchedUrls).toEqual(['https://api-develop.poli.page/v1/me']);
		expect(errors).toEqual([]);
	});

	it.each([
		['--api-url', (url: string) => ['--api-url', url, 'whoami']],
		['POLI_API_URL', (url: string) => (vi.stubEnv('POLI_API_URL', url), ['whoami'])],
	])('%s to an untrusted host exits 2 before any request', async (_label, argsFor) => {
		vi.stubEnv('POLI_PAGE_API_KEY', testApiKey('live'));
		for (const url of [
			'https://evil.com',
			'https://api.poli.page@evil.com',
			'https://evil.com\\@api.poli.page',
			'https://api.poli.page/v1',
			'https://api.poli.page/?q=1',
			'https://api.poli.page/#h',
			'http://127.0.0.1:9',
		]) {
			await expect(poli(...argsFor(url))).rejects.toMatchObject({
				exitCode: ExitCode.INVALID_USAGE,
			});
		}
		expect(fetchedUrls).toEqual([]);
	});

	it.each([
		['--allow-insecure-api', (origin: string) => ['--api-url', origin, '--allow-insecure-api', 'whoami']],
		[
			'POLI_ALLOW_INSECURE_API=1',
			(origin: string) => (vi.stubEnv('POLI_ALLOW_INSECURE_API', '1'), ['--api-url', origin, 'whoami']),
		],
	])('loopback works with %s', async (_label, argsFor) => {
		vi.stubEnv('POLI_PAGE_API_KEY', testApiKey('live'));
		const local = await listen(() => ({ status: 200, body: JSON.stringify(ME) }));
		try {
			await poli(...argsFor(local.origin));
			expect(local.received).toHaveLength(1);
			expect(local.received[0].url).toBe('/v1/me');
		} finally {
			await local.close();
		}
	});

	it('never sends a session stored for one origin to another', async () => {
		await writeCredentials(SESSION, fakeHome);
		await linkProject();
		const other = await listen(() => ({ status: 200, body: JSON.stringify(ME) }));
		try {
			await poli('--api-url', other.origin, '--allow-insecure-api', 'whoami');
			expect(other.received).toHaveLength(0);
			expect(process.exitCode).toBe(ExitCode.NOT_AUTHENTICATED);
			expect(errors.join('\n')).toMatch(/issued by https:\/\/api\.poli\.page/);
		} finally {
			await other.close();
		}
	});

	it('outside a linked folder, never lists organizations with a session from another origin', async () => {
		await writeCredentials(SESSION, fakeHome);
		const other = await listen(() => ({ status: 200, body: '[]' }));
		try {
			await poli('--api-url', other.origin, '--allow-insecure-api', 'whoami');
			expect(other.received).toHaveLength(0);
			expect(process.exitCode).toBe(ExitCode.NOT_AUTHENTICATED);
			expect(errors.join('\n')).toMatch(/issued by https:\/\/api\.poli\.page/);
		} finally {
			await other.close();
		}
	});

	it('poli link never lists organizations with a session from another origin', async () => {
		await writeCredentials(SESSION, fakeHome);
		await poli('--api-url', 'https://api-develop.poli.page', 'link');
		expect(fetchedUrls).toEqual([]);
		expect(process.exitCode).toBe(ExitCode.NOT_AUTHENTICATED);
	});

	it('a 307 from the API fails the command, and the target receives nothing', async () => {
		vi.stubEnv('POLI_PAGE_API_KEY', testApiKey('live'));
		const target = await listen();
		const api = await listen(() => ({ status: 307, headers: { Location: `${target.origin}/v1/me` } }));
		try {
			await poli('--api-url', api.origin, '--allow-insecure-api', 'whoami');
			expect(api.received).toHaveLength(1);
			expect(target.received).toHaveLength(0);
			expect(process.exitCode).toBeGreaterThan(0);
		} finally {
			await api.close();
			await target.close();
		}
	});
});
