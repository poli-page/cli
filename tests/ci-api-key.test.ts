import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuth } from '../src/auth.js';
import { createApiClient } from '../src/api-client.js';
import { writeManifest } from '../src/manifest.js';
import type { PoliPageManifest } from '../src/manifest.js';
import { testApiKey } from './helpers/api-key.js';

/**
 * CI-style integration tests: the user has set POLI_PAGE_API_KEY (a
 * `pp_<environment>_…` key) but never ran `poli login`. The CLI must talk to the API in
 * api-key mode without any session token.
 */
describe('CI integration with POLI_PAGE_API_KEY', () => {
	let tempDir: string;
	let fakeHome: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-ci-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-ci-home-'));
		savedEnv = process.env.POLI_PAGE_API_KEY;
		delete process.env.POLI_PAGE_API_KEY;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
		if (savedEnv === undefined) {
			delete process.env.POLI_PAGE_API_KEY;
		} else {
			process.env.POLI_PAGE_API_KEY = savedEnv;
		}
	});

	it('resolveAuth returns api-key mode for a pp_<environment>_ key with no session', async () => {
		process.env.POLI_PAGE_API_KEY = testApiKey('live');
		const ctx = await resolveAuth({ homeDir: fakeHome });
		expect(ctx).toEqual({
			mode: 'api-key',
			authorization: `Bearer ${testApiKey('live')}`,
			environment: 'live',
		});
		expect(ctx.orgIdHeader).toBeUndefined();
	});

	it('resolveAuth rejects keys not starting with pp_', async () => {
		process.env.POLI_PAGE_API_KEY = 'not_a_pp_key';
		await expect(resolveAuth({ homeDir: fakeHome })).rejects.toThrow(/POLI_PAGE_API_KEY.*pp_/i);
	});

	it('passes the Bearer key header on the underlying request (createApiClient)', async () => {
		process.env.POLI_PAGE_API_KEY = testApiKey('live');
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ thumbnails: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const ctx = await resolveAuth({ homeDir: fakeHome });
		const client = createApiClient('https://api.test');
		await client.documentThumbnails(ctx.authorization, ctx.orgIdHeader, 'doc_x', {
			width: 200,
		});

		const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<
			string,
			string
		>;
		expect(headers.Authorization).toBe(`Bearer ${testApiKey('live')}`);
		expect(headers['X-Poli-Org-Id']).toBeUndefined();
		vi.unstubAllGlobals();
	});

	it('end-to-end: resolveAuth works in CI with an API key in a linked project (no login)', async () => {
		process.env.POLI_PAGE_API_KEY = testApiKey('live');
		await writeManifest(tempDir, {
			project: { name: 'demo', version: '0.1.0' },
			cloud: {
				orgSlug: 'acme',
				orgId: 'org_1',
				projectSlug: 'invoices',
				projectId: 'proj_1',
			},
			templates: [],
		} as PoliPageManifest);

		// resolveCloudContext (used by watch and dev) uses the session path: it
		// requires credentials and session tokens. The API-key CI path applies
		// only to commands that go through resolveAuth (render, documents).
		// We verify here that resolveAuth itself works with a key end-to-end
		// for an api-client method.
		const ctx = await resolveAuth({
			homeDir: fakeHome,
			manifestOrgId: 'org_1',
		});
		expect(ctx.mode).toBe('api-key');
	});

	it('credentials file precedence: session wins over env var', async () => {
		process.env.POLI_PAGE_API_KEY = testApiKey('live');
		const { writeCredentials } = await import('../src/credentials.js');
		await writeCredentials(
			{
				session: 'session-from-login',
				user: { id: '1', name: 'X', email: 'x@x.com' },
				orgs: {},
			},
			fakeHome
		);

		const ctx = await resolveAuth({
			manifestOrgId: 'org_1',
			homeDir: fakeHome,
		});
		expect(ctx.mode).toBe('session');
		expect(ctx.authorization).toBe('Bearer session-from-login');
	});
});
