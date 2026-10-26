import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApiClient } from '../src/api-client.js';

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

describe('api-client publish', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('POSTs the bundle to /v1/projects/:project/publish with the session and X-Poli-Org-Id', async () => {
		const response = {
			environment: 'live',
			project: 'invoices',
			publishedAt: '2026-10-26T10:00:00.000Z',
			bundleHash: `sha256:${'a'.repeat(64)}`,
			logId: 'log_1',
			fileCount: 2,
			totalBytes: 42,
		};
		const fetchMock = mockFetchOnce(200, response);

		const client = createApiClient('https://api.test');
		const body = {
			environment: 'live',
			message: 'Release',
			files: [
				{ path: 'poli-page.json', encoding: 'utf8' as const, content: '{}' },
				{
					path: 'assets/images/logo.png',
					encoding: 'base64' as const,
					content: 'iVBORw==',
				},
			],
		};
		const result = await client.publish('sess-tok', 'org_1', 'invoices', body);

		expect(result).toEqual(response);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://api.test/v1/projects/invoices/publish');
		expect((init as RequestInit).method).toBe('POST');
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer sess-tok');
		expect(headers['X-Poli-Org-Id']).toBe('org_1');
		expect(JSON.parse((init as RequestInit).body as string)).toEqual(body);
	});

	it('encodes the project slug in the path', async () => {
		const fetchMock = mockFetchOnce(200, {});
		const client = createApiClient('https://api.test');
		await client.publish('sess-tok', 'org_1', '../admin', { environment: 'live', files: [] });
		expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/v1/projects/..%2Fadmin/publish');
	});
});

describe('api-client listEnvironments', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("GETs the organization's environments with the session", async () => {
		const environments = [
			{
				name: 'sandbox',
				kind: 'sandbox',
				protected: false,
				readOnly: false,
				createdAt: '2026-10-01T00:00:00.000Z',
				projectCount: 1,
			},
			{
				name: 'live',
				kind: 'standard',
				protected: true,
				readOnly: false,
				createdAt: '2026-10-01T00:00:00.000Z',
				projectCount: 0,
			},
		];
		const fetchMock = mockFetchOnce(200, environments);

		const client = createApiClient('https://api.test');
		const result = await client.listEnvironments('sess-tok', 'org_1');

		expect(result).toEqual(environments);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://api.test/api/organizations/org_1/environments');
		expect((init as RequestInit).method ?? 'GET').toBe('GET');
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer sess-tok');
	});
});
