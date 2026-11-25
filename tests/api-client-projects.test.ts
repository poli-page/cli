import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApiClient, type ApiClient } from '../src/api-client.js';

function mockFetchOnce(status: number, body: unknown): ReturnType<typeof vi.fn> {
	const response = new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
	const fn = vi.fn().mockResolvedValue(response);
	vi.stubGlobal('fetch', fn);
	return fn;
}

describe('api-client organization projects', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('listProjects encodes the organization id in the path', async () => {
		const fetchMock = mockFetchOnce(200, []);
		const client = createApiClient('https://api.poli.page');
		await client.listProjects('sess-tok', 'o/../../api/x?y=');
		expect(fetchMock.mock.calls[0][0]).toBe(
			'https://api.poli.page/api/organizations/o%2F..%2F..%2Fapi%2Fx%3Fy%3D/projects'
		);
	});

	it('createProject encodes the organization id in the path', async () => {
		const fetchMock = mockFetchOnce(200, { id: 'p' });
		const client = createApiClient('https://api.poli.page');
		await client.createProject('sess-tok', 'o/../../api/x?y=', { name: 'n', slug: 's' });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			'https://api.poli.page/api/organizations/o%2F..%2F..%2Fapi%2Fx%3Fy%3D/projects'
		);
		expect((init as RequestInit).method).toBe('POST');
	});

	it.each([
		['listProjects', (c: ApiClient) => c.listProjects('sess-tok', '..')],
		['createProject', (c: ApiClient) => c.createProject('sess-tok', '..', { name: 'n' })],
	])('%s refuses the dot segment without a request', async (_name, call) => {
		const fetchMock = mockFetchOnce(200, []);
		await expect(call(createApiClient('https://api.poli.page'))).rejects.toThrow(
			'Invalid organization ID.'
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
