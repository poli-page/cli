import { describe, it, expect, afterEach, vi } from 'vitest';
import { ApiError, createApiClient } from '../src/api-client.js';

describe('api-client renderDraft', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('POSTs /v1/render/draft with the session and org, and returns the PDF bytes', async () => {
		const pdfBytes = Buffer.from('%PDF-1.7\ndraft bytes');
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(pdfBytes, {
				status: 200,
				headers: { 'Content-Type': 'application/pdf' },
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const client = createApiClient('https://api.test');
		const result = await client.renderDraft('Bearer sess-tok', 'org_1', {
			project: 'invoices',
			template: 'invoice',
			data: { title: 'Hello' },
			format: 'A4',
		});

		expect(Buffer.isBuffer(result)).toBe(true);
		expect(result.equals(pdfBytes)).toBe(true);

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://api.test/v1/render/draft');
		expect((init as RequestInit).method).toBe('POST');
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer sess-tok');
		expect(headers['X-Poli-Org-Id']).toBe('org_1');
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			project: 'invoices',
			template: 'invoice',
			data: { title: 'Hello' },
			format: 'A4',
		});
	});

	it('surfaces DRAFT_REQUIRES_SESSION as an ApiError', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'DRAFT_REQUIRES_SESSION', requestId: 'r' }), {
					status: 403,
					headers: { 'Content-Type': 'application/json' },
				})
			)
		);

		const client = createApiClient('https://api.test');
		const failure = client.renderDraft('Bearer pp_sandbox_x', 'org_1', {
			project: 'invoices',
			template: 'invoice',
			data: {},
		});
		await expect(failure).rejects.toBeInstanceOf(ApiError);
		await expect(failure).rejects.toMatchObject({
			code: 'DRAFT_REQUIRES_SESSION',
			httpStatus: 403,
		});
	});
});
