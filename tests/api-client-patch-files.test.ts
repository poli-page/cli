import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApiClient } from '../src/api-client.js';

function mockFetchOnce(
	status: number,
	body: unknown,
	headers: Record<string, string> = { 'Content-Type': 'application/json' }
): ReturnType<typeof vi.fn> {
	const response = new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status,
		headers,
	});
	const fn = vi.fn().mockResolvedValue(response);
	vi.stubGlobal('fetch', fn);
	return fn;
}

describe('api-client patchFiles', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('PATCHes /api/organizations/:orgId/projects/:projectId/files with the delta payload', async () => {
		const fetchMock = mockFetchOnce(200, { syncedAt: '2026-05-06T10:00:00.000Z' });

		const client = createApiClient('https://api.test');
		const result = await client.patchFiles('sess-tok', 'org_1', 'proj_1', {
			added: [{ path: 'templates/new.html', content: '<h1>new</h1>' }],
			modified: [{ path: 'templates/inv.html', content: '<h1>updated</h1>' }],
			deleted: ['templates/old.html'],
		});

		expect(result).toEqual({ syncedAt: '2026-05-06T10:00:00.000Z' });

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://api.test/api/organizations/org_1/projects/proj_1/files');
		expect((init as RequestInit).method).toBe('PATCH');

		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer sess-tok');

		const body = JSON.parse((init as RequestInit).body as string);
		expect(body).toEqual({
			added: [{ path: 'templates/new.html', content: '<h1>new</h1>' }],
			modified: [{ path: 'templates/inv.html', content: '<h1>updated</h1>' }],
			deleted: ['templates/old.html'],
		});
	});

	it('sends empty arrays when the delta has no changes in a category', async () => {
		const fetchMock = mockFetchOnce(200, { syncedAt: '2026-05-06T10:00:00.000Z' });

		const client = createApiClient('https://api.test');
		await client.patchFiles('sess-tok', 'org_1', 'proj_1', {
			added: [],
			modified: [{ path: 'templates/inv.html', content: 'x' }],
			deleted: [],
		});

		const body = JSON.parse(
			(fetchMock.mock.calls[0][1] as RequestInit).body as string
		);
		expect(body.added).toEqual([]);
		expect(body.deleted).toEqual([]);
		expect(body.modified).toHaveLength(1);
	});
});
