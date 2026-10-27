import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApiClient, type ProjectEnvironmentState } from '../src/api-client.js';

function mockFetchOnce(status: number, body: unknown): ReturnType<typeof vi.fn> {
	const fn = vi.fn().mockResolvedValue(
		new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		})
	);
	vi.stubGlobal('fetch', fn);
	return fn;
}

describe('api-client getProjectEnvironments', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("GETs the project's state in each environment with the session", async () => {
		const states: ProjectEnvironmentState[] = [
			{
				environment: 'sandbox',
				kind: 'sandbox',
				protected: false,
				readOnly: false,
				published: true,
				lastPublish: {
					id: 'log_1',
					status: 'succeeded',
					errorCode: null,
					startedAt: '2026-10-26T10:00:00.000Z',
					publishedAt: '2026-10-26T10:00:02.000Z',
					author: { type: 'user', id: 'u1', displayName: 'Ada' },
					message: null,
					bundleHash: `sha256:${'a'.repeat(64)}`,
					fileCount: 3,
					totalBytes: 120,
				},
			},
			{
				environment: 'live',
				kind: 'standard',
				protected: true,
				readOnly: false,
				published: false,
				lastPublish: null,
			},
		];
		const fetchMock = mockFetchOnce(200, states);

		const client = createApiClient('https://api.test');
		const result = await client.getProjectEnvironments('sess-tok', 'org_1', 'proj_1');

		expect(result).toEqual(states);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://api.test/api/organizations/org_1/projects/proj_1/environments');
		expect((init as RequestInit).method ?? 'GET').toBe('GET');
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer sess-tok');
	});

	// Both ids come from poli-page.json, which the user can edit.
	it('encodes the organization and project ids in the path', async () => {
		const fetchMock = mockFetchOnce(200, []);
		const client = createApiClient('https://api.test');
		await client.getProjectEnvironments('sess-tok', 'x/../..', 'p/../q');
		expect(fetchMock.mock.calls[0][0]).toBe(
			'https://api.test/api/organizations/x%2F..%2F../projects/p%2F..%2Fq/environments'
		);
	});

	it.each([
		['.', 'proj_1', 'Invalid organization ID.'],
		['..', 'proj_1', 'Invalid organization ID.'],
		['org_1', '.', 'Invalid project ID.'],
		['org_1', '..', 'Invalid project ID.'],
	])(
		'refuses the dot segment in (%s, %s) without a request',
		async (orgId, projectId, message) => {
			const fetchMock = mockFetchOnce(200, []);
			const client = createApiClient('https://api.test');
			await expect(
				client.getProjectEnvironments('sess-tok', orgId, projectId)
			).rejects.toThrow(message);
			expect(fetchMock).not.toHaveBeenCalled();
		}
	);
});

describe('api-client removeProjectFromEnvironment', () => {
	function mockNoContent(): ReturnType<typeof vi.fn> {
		const fn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', fn);
		return fn;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('DELETEs the project from the environment with the session and reads no body', async () => {
		const fetchMock = mockNoContent();
		const client = createApiClient('https://api.test');
		await expect(
			client.removeProjectFromEnvironment('sess-tok', 'org_1', 'proj_1', 'live')
		).resolves.toBeUndefined();

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			'https://api.test/api/organizations/org_1/projects/proj_1/environments/live'
		);
		expect((init as RequestInit).method).toBe('DELETE');
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer sess-tok');
	});

	it('encodes every path segment', async () => {
		const fetchMock = mockNoContent();
		const client = createApiClient('https://api.test');
		await client.removeProjectFromEnvironment('sess-tok', 'x/..', 'p/..', 'l/..');
		expect(fetchMock.mock.calls[0][0]).toBe(
			'https://api.test/api/organizations/x%2F../projects/p%2F../environments/l%2F..'
		);
	});

	it.each([
		['..', 'proj_1', 'live', 'Invalid organization ID.'],
		['org_1', '..', 'live', 'Invalid project ID.'],
		['org_1', 'proj_1', '..', 'Invalid environment ID.'],
	])(
		'refuses the dot segment in (%s, %s, %s) without a request',
		async (orgId, projectId, environment, message) => {
			const fetchMock = mockNoContent();
			const client = createApiClient('https://api.test');
			await expect(
				client.removeProjectFromEnvironment('sess-tok', orgId, projectId, environment)
			).rejects.toThrow(message);
			expect(fetchMock).not.toHaveBeenCalled();
		}
	);
});
