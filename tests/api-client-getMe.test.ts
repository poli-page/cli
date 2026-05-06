import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApiClient, MissingOrgContextError } from '../src/api-client.js';

interface FetchCall {
	url: string;
	init: RequestInit;
}

function mockFetch(
	body: unknown,
	status = 200,
	captured?: FetchCall[]
): void {
	const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
		captured?.push({ url, init });
		return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	});
	vi.stubGlobal('fetch', fn);
}

describe('api-client getMe', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('GETs /v1/me with Authorization and X-Poli-Org-Id when orgIdHeader is provided', async () => {
		const calls: FetchCall[] = [];
		mockFetch(
			{
				auth: { mode: 'session', keyType: 'session', environment: null },
				user: { id: 'u1', email: 'x@test', name: 'Xavier', username: 'xavier' },
				key: null,
				org: { id: 'o1', slug: 'acme', name: 'Acme', tier: 'free', lifecycleStatus: 'active' },
			},
			200,
			calls
		);
		const client = createApiClient('https://api.test');
		const me = await client.getMe('Bearer session-token-abc', 'org-uuid-acme');

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://api.test/v1/me');
		expect(calls[0].init.method).toBe('GET');
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer session-token-abc');
		expect(headers['X-Poli-Org-Id']).toBe('org-uuid-acme');

		expect(me.auth.mode).toBe('session');
		expect(me.user?.email).toBe('x@test');
		expect(me.org?.slug).toBe('acme');
	});

	it('GETs /v1/me without X-Poli-Org-Id in API-key mode', async () => {
		const calls: FetchCall[] = [];
		mockFetch(
			{
				auth: { mode: 'api-key', keyType: 'live', environment: 'live' },
				user: null,
				key: {
					id: 'k1',
					name: 'CI key',
					prefix: 'pp_live_',
					preview: 'pp_live_xxx…abcd',
					createdAt: '2026-05-01T00:00:00.000Z',
					lastUsedAt: null,
				},
				org: { id: 'o1', slug: 'acme', name: 'Acme', tier: 'starter', lifecycleStatus: 'active' },
			},
			200,
			calls
		);
		const client = createApiClient('https://api.test');
		const me = await client.getMe('Bearer pp_live_abc');

		expect(calls).toHaveLength(1);
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer pp_live_abc');
		expect('X-Poli-Org-Id' in headers).toBe(false);

		expect(me.auth.mode).toBe('api-key');
		expect(me.auth.environment).toBe('live');
		expect(me.user).toBeNull();
		expect(me.key?.preview).toBe('pp_live_xxx…abcd');
	});

	it('propagates typed errors from /v1/me (MISSING_ORG_CONTEXT)', async () => {
		mockFetch(
			{ error: { code: 'MISSING_ORG_CONTEXT', message: 'no org header' } },
			400
		);
		const client = createApiClient('https://api.test');
		await expect(client.getMe('Bearer session')).rejects.toBeInstanceOf(
			MissingOrgContextError
		);
	});
});
