import { describe, it, expect, afterEach, vi } from 'vitest';
import { ApiError, createApiClient } from '../src/api-client.js';

interface FetchCall {
	url: string;
	init: RequestInit;
}

function mockFetch(status: number, body: string, captured: FetchCall[]): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit = {}) => {
			captured.push({ url, init });
			return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
		})
	);
}

describe('api-client signOut', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('POSTs /api/auth/sign-out with the session as a bearer token and no body', async () => {
		const calls: FetchCall[] = [];
		mockFetch(200, '{"success":true}', calls);

		await createApiClient('https://api.poli.page').signOut('session-token-abc');

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://api.poli.page/api/auth/sign-out');
		expect(calls[0].init.method).toBe('POST');
		expect(calls[0].init.body).toBeUndefined();
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer session-token-abc');
	});

	it('rejects with the API error when the sign-out is refused', async () => {
		const calls: FetchCall[] = [];
		mockFetch(401, '{"code":"UNAUTHORIZED","message":"Unauthorized"}', calls);

		await expect(createApiClient('https://api.poli.page').signOut('stale')).rejects.toBeInstanceOf(
			ApiError
		);
	});
});
