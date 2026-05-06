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

describe('api-client documents', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('getDocument', () => {
		it('returns the descriptor for GET /v1/documents/:id', async () => {
			const fakeDoc = {
				documentId: 'doc_abc',
				organizationId: 'org_1',
				projectId: 'proj_1',
				projectSlug: 'invoices',
				templateId: 'tpl_1',
				templateSlug: 'invoice',
				version: '1.0.5',
				environment: 'live',
				apiKeyId: 'key_1',
				createdAt: '2026-04-15T14:32:18.000Z',
				pageCount: 2,
				sizeBytes: 18432,
				format: 'A4',
				orientation: 'portrait',
				locale: 'en',
				metadata: { chantierId: 123 },
				presignedPdfUrl: 'https://s3.example/doc_abc.pdf?sig=abc',
				expiresAt: '2026-04-15T14:47:18.000Z',
			};
			const fetchMock = mockFetchOnce(200, fakeDoc);

			const client = createApiClient('https://api.test');
			const result = await client.getDocument(
				'Bearer pp_live_xyz',
				'org_1',
				'doc_abc'
			);

			expect(result).toEqual(fakeDoc);
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe('https://api.test/v1/documents/doc_abc');
			expect((init as RequestInit).method).toBe('GET');
			const headers = (init as RequestInit).headers as Record<string, string>;
			expect(headers.Authorization).toBe('Bearer pp_live_xyz');
			expect(headers['X-Poli-Org-Id']).toBe('org_1');
		});

		it('encodes the id in the URL path', async () => {
			const fetchMock = mockFetchOnce(200, {
				documentId: 'doc/with/slash',
				organizationId: 'org_1',
				projectId: null,
				projectSlug: null,
				templateId: null,
				templateSlug: null,
				version: '1.0.0',
				environment: 'sandbox',
				apiKeyId: null,
				createdAt: '2026-04-15T14:32:18.000Z',
				pageCount: 1,
				sizeBytes: 1024,
				format: 'A4',
				orientation: 'portrait',
				locale: null,
				metadata: {},
				presignedPdfUrl: 'https://s3.example/doc.pdf',
				expiresAt: '2026-04-15T14:47:18.000Z',
			});
			const client = createApiClient('https://api.test');
			await client.getDocument('Bearer x', 'org_1', 'doc/with/slash');
			expect(fetchMock.mock.calls[0][0]).toBe(
				'https://api.test/v1/documents/doc%2Fwith%2Fslash'
			);
		});

		it('omits X-Poli-Org-Id when orgIdHeader is undefined (api-key mode)', async () => {
			const fetchMock = mockFetchOnce(200, {
				documentId: 'doc_abc',
				organizationId: 'org_1',
				projectId: null,
				projectSlug: null,
				templateId: null,
				templateSlug: null,
				version: '1.0.0',
				environment: 'sandbox',
				apiKeyId: null,
				createdAt: '2026-04-15T14:32:18.000Z',
				pageCount: 1,
				sizeBytes: 1024,
				format: 'A4',
				orientation: 'portrait',
				locale: null,
				metadata: {},
				presignedPdfUrl: 'https://s3.example/doc_abc.pdf',
				expiresAt: '2026-04-15T14:47:18.000Z',
			});

			const client = createApiClient('https://api.test');
			await client.getDocument('Bearer pp_test_xyz', undefined, 'doc_abc');

			const [, init] = fetchMock.mock.calls[0];
			const headers = (init as RequestInit).headers as Record<string, string>;
			expect(headers['X-Poli-Org-Id']).toBeUndefined();
		});
	});

	describe('deleteDocument', () => {
		it('sends DELETE /v1/documents/:id and returns void on 204', async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				new Response(null, { status: 204 })
			);
			vi.stubGlobal('fetch', fetchMock);

			const client = createApiClient('https://api.test');
			const result = await client.deleteDocument(
				'Bearer pp_live_x',
				'org_1',
				'doc_abc'
			);

			expect(result).toBeUndefined();
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe('https://api.test/v1/documents/doc_abc');
			expect((init as RequestInit).method).toBe('DELETE');
			const headers = (init as RequestInit).headers as Record<string, string>;
			expect(headers.Authorization).toBe('Bearer pp_live_x');
			expect(headers['X-Poli-Org-Id']).toBe('org_1');
		});

		it('omits X-Poli-Org-Id when orgIdHeader is undefined', async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				new Response(null, { status: 204 })
			);
			vi.stubGlobal('fetch', fetchMock);

			const client = createApiClient('https://api.test');
			await client.deleteDocument('Bearer pp_live_x', undefined, 'doc_abc');

			const [, init] = fetchMock.mock.calls[0];
			const headers = (init as RequestInit).headers as Record<string, string>;
			expect(headers['X-Poli-Org-Id']).toBeUndefined();
		});
	});

	describe('documentThumbnails', () => {
		it('POSTs thumbnails options and unwraps the thumbnails array', async () => {
			const fakeThumb = {
				page: 1,
				width: 400,
				height: 566,
				contentType: 'image/jpeg',
				data: 'base64-jpeg-data',
			};
			const fetchMock = mockFetchOnce(200, { thumbnails: [fakeThumb] });

			const client = createApiClient('https://api.test');
			const result = await client.documentThumbnails(
				'Bearer pp_live_x',
				'org_1',
				'doc_abc',
				{ width: 400, format: 'jpeg', quality: 90, pages: [1, 3] }
			);

			expect(result).toEqual([fakeThumb]);
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe('https://api.test/v1/documents/doc_abc/thumbnails');
			expect((init as RequestInit).method).toBe('POST');
			const body = JSON.parse((init as RequestInit).body as string);
			expect(body).toEqual({
				thumbnails: { width: 400, format: 'jpeg', quality: 90, pages: [1, 3] },
			});
			const headers = (init as RequestInit).headers as Record<string, string>;
			expect(headers.Authorization).toBe('Bearer pp_live_x');
			expect(headers['X-Poli-Org-Id']).toBe('org_1');
		});

		it('omits undefined thumbnail fields from the body', async () => {
			const fetchMock = mockFetchOnce(200, { thumbnails: [] });

			const client = createApiClient('https://api.test');
			await client.documentThumbnails('Bearer pp_test_x', undefined, 'doc_abc', {
				width: 200,
			});

			const body = JSON.parse(
				(fetchMock.mock.calls[0][1] as RequestInit).body as string
			);
			expect(body).toEqual({ thumbnails: { width: 200 } });
		});
	});

	describe('documentPreview', () => {
		it('returns the HTML body and page count from the X-Document-Page-Count header', async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				new Response('<html>preview</html>', {
					status: 200,
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
						'X-Document-Page-Count': '4',
					},
				})
			);
			vi.stubGlobal('fetch', fetchMock);

			const client = createApiClient('https://api.test');
			const result = await client.documentPreview(
				'Bearer pp_live_x',
				'org_1',
				'doc_abc'
			);

			expect(result).toEqual({ html: '<html>preview</html>', pageCount: 4 });
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe('https://api.test/v1/documents/doc_abc/preview');
			expect((init as RequestInit).method).toBe('GET');
			const headers = (init as RequestInit).headers as Record<string, string>;
			expect(headers.Authorization).toBe('Bearer pp_live_x');
			expect(headers['X-Poli-Org-Id']).toBe('org_1');
		});

		it('falls back to pageCount=0 when the header is missing or invalid', async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				new Response('<html>preview</html>', {
					status: 200,
					headers: { 'Content-Type': 'text/html' },
				})
			);
			vi.stubGlobal('fetch', fetchMock);

			const client = createApiClient('https://api.test');
			const result = await client.documentPreview(
				'Bearer pp_test_x',
				undefined,
				'doc_abc'
			);

			expect(result.pageCount).toBe(0);
			expect(result.html).toBe('<html>preview</html>');
		});
	});
});
