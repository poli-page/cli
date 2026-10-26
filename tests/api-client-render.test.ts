import { describe, it, expect, afterEach, vi } from 'vitest';
import { ApiError, createApiClient, type RenderResult } from '../src/api-client.js';

const fakeDescriptor: RenderResult = {
	documentId: 'doc_abc123',
	organizationId: 'org_1',
	projectId: 'proj_1',
	projectSlug: 'invoices',
	templateId: 'tpl_1',
	templateSlug: 'invoice',
	environment: 'production',
	apiKeyId: 'key_1',
	createdAt: '2026-05-07T12:00:00.000Z',
	pageCount: 2,
	sizeBytes: 18432,
	format: 'A4',
	orientation: 'portrait',
	locale: 'en',
	metadata: {},
	presignedPdfUrl: 'https://s3.example/doc_abc123.pdf?sig=abc',
	expiresAt: '2026-05-07T12:15:00.000Z',
	diagnostics: [{ kind: 'missing-asset', message: 'Image not found', path: 'images/logo.png' }],
};

function mockFetchOnce(status: number, body: unknown): ReturnType<typeof vi.fn> {
	const response = new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
	const fn = vi.fn().mockResolvedValue(response);
	vi.stubGlobal('fetch', fn);
	return fn;
}

describe('api-client render', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('POSTs /v1/render with auth + body and returns the JSON descriptor', async () => {
		const fetchMock = mockFetchOnce(200, fakeDescriptor);

		const client = createApiClient('https://api.test');
		const result = await client.render('Bearer pp_live_abc', 'org_1', {
			project: 'invoices',
			template: 'invoice',
			environment: 'production',
			data: { title: 'Hello' },
		});

		expect(result).toEqual(fakeDescriptor);

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://api.test/v1/render');
		expect((init as RequestInit).method).toBe('POST');

		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer pp_live_abc');
		expect(headers['X-Poli-Org-Id']).toBe('org_1');

		const body = JSON.parse((init as RequestInit).body as string);
		expect(body).toEqual({
			project: 'invoices',
			template: 'invoice',
			environment: 'production',
			data: { title: 'Hello' },
		});
	});

	it('omits X-Poli-Org-Id when orgIdHeader is undefined (api-key mode)', async () => {
		const fetchMock = mockFetchOnce(200, fakeDescriptor);

		const client = createApiClient('https://api.test');
		await client.render('Bearer pp_test_x', undefined, {
			project: 'invoices',
			template: 'invoice',
			data: {},
		});

		const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<
			string,
			string
		>;
		expect(headers['X-Poli-Org-Id']).toBeUndefined();
	});
});

describe('api-client renderDraft', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('POSTs /v1/render/draft with the session and org header and returns the PDF bytes', async () => {
		const pdf = Buffer.from('%PDF-1.7 draft');
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(pdf, { status: 200, headers: { 'Content-Type': 'application/pdf' } })
			);
		vi.stubGlobal('fetch', fetchMock);

		const client = createApiClient('https://api.test');
		const result = await client.renderDraft('Bearer sess', 'org_1', {
			project: 'invoices',
			template: 'invoice',
			data: { title: 'Hello' },
		});

		expect(Buffer.isBuffer(result)).toBe(true);
		expect(result.equals(pdf)).toBe(true);

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://api.test/v1/render/draft');
		expect((init as RequestInit).method).toBe('POST');
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer sess');
		expect(headers['X-Poli-Org-Id']).toBe('org_1');
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			project: 'invoices',
			template: 'invoice',
			data: { title: 'Hello' },
		});
	});

	it('surfaces 403 DRAFT_REQUIRES_SESSION as an ApiError', async () => {
		mockFetchOnce(403, {
			error: 'DRAFT_REQUIRES_SESSION',
			detail: 'Only a session renders the draft.',
		});

		const client = createApiClient('https://api.test');
		const error = await client
			.renderDraft('Bearer pp_live_x', 'org_1', { project: 'p', template: 't', data: {} })
			.catch((err: unknown) => err);

		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).code).toBe('DRAFT_REQUIRES_SESSION');
		expect((error as ApiError).httpStatus).toBe(403);
	});
});
