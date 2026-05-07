import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	createApiClient,
	ApiError,
	QuotaExceededError,
	OverageCapError,
	PaymentRequiredError,
	OrgCancelledError,
	OrgPurgedError,
	OrgMigratingError,
	InvalidVersionFormatError,
	InvalidVersionForKeyEnvError,
	VersionRequiredError,
	MissingOrgContextError,
	NotAMemberError,
	ThumbnailsNotAvailableError,
	DocumentNotFoundError,
	DocumentGoneError,
	SystemProjectLockedError,
	SystemProjectImmutableError,
} from '../src/api-client.js';

function mockFetchOnce(
	status: number,
	body: unknown,
	headers: Record<string, string> = {}
) {
	const response = new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	});
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue(response)
	);
}

describe('api-client error mapping', () => {
	beforeEach(() => {
		// Each test sets its own fetch mock
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function callAnyEndpoint() {
		const client = createApiClient('https://api.test');
		return client.getOrganizations('session-token');
	}

	describe('typed error classes for known API codes', () => {
		it('maps 429 QUOTA_EXCEEDED → QuotaExceededError + Retry-After', async () => {
			mockFetchOnce(
				429,
				{ error: { code: 'QUOTA_EXCEEDED', message: 'Free plan: 100/mo' } },
				{ 'Retry-After': '12345' }
			);
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err).toBeInstanceOf(QuotaExceededError);
			expect(err).toBeInstanceOf(ApiError);
			expect(err.code).toBe('QUOTA_EXCEEDED');
			expect(err.httpStatus).toBe(429);
			expect(err.retryAfter).toBe(12345);
			expect(err.message).toMatch(/Free plan/);
		});

		it('maps 429 OVERAGE_CAP_EXCEEDED → OverageCapError', async () => {
			mockFetchOnce(429, {
				error: { code: 'OVERAGE_CAP_EXCEEDED', message: 'cap reached' },
			});
			await expect(callAnyEndpoint()).rejects.toBeInstanceOf(OverageCapError);
		});

		it('maps 402 PAYMENT_REQUIRED → PaymentRequiredError', async () => {
			mockFetchOnce(402, {
				error: { code: 'PAYMENT_REQUIRED', message: 'past due' },
			});
			await expect(callAnyEndpoint()).rejects.toBeInstanceOf(PaymentRequiredError);
		});

		it('maps 403 ORGANIZATION_CANCELLED → OrgCancelledError', async () => {
			mockFetchOnce(403, {
				error: { code: 'ORGANIZATION_CANCELLED', message: 'cancelled' },
			});
			await expect(callAnyEndpoint()).rejects.toBeInstanceOf(OrgCancelledError);
		});

		it('maps 410 ORGANIZATION_PURGED → OrgPurgedError', async () => {
			mockFetchOnce(410, {
				error: { code: 'ORGANIZATION_PURGED', message: 'purged' },
			});
			await expect(callAnyEndpoint()).rejects.toBeInstanceOf(OrgPurgedError);
		});

		it('maps 503 ORGANIZATION_MIGRATING → OrgMigratingError', async () => {
			mockFetchOnce(503, {
				error: { code: 'ORGANIZATION_MIGRATING', message: 'migrating' },
			});
			await expect(callAnyEndpoint()).rejects.toBeInstanceOf(OrgMigratingError);
		});

		it('maps 400 INVALID_VERSION_FORMAT → InvalidVersionFormatError', async () => {
			mockFetchOnce(400, {
				error: { code: 'INVALID_VERSION_FORMAT', message: 'bad format' },
			});
			await expect(callAnyEndpoint()).rejects.toBeInstanceOf(
				InvalidVersionFormatError
			);
		});

		it('maps 400 INVALID_VERSION_FOR_KEY_ENV → InvalidVersionForKeyEnvError', async () => {
			mockFetchOnce(400, {
				error: {
					code: 'INVALID_VERSION_FOR_KEY_ENV',
					message: 'mismatch',
				},
			});
			await expect(callAnyEndpoint()).rejects.toBeInstanceOf(
				InvalidVersionForKeyEnvError
			);
		});

		it('maps 400 VERSION_REQUIRED → VersionRequiredError', async () => {
			mockFetchOnce(400, {
				error: { code: 'VERSION_REQUIRED', message: 'version required' },
			});
			await expect(callAnyEndpoint()).rejects.toBeInstanceOf(VersionRequiredError);
		});

		it('maps 400 MISSING_ORG_CONTEXT → MissingOrgContextError', async () => {
			mockFetchOnce(400, {
				error: { code: 'MISSING_ORG_CONTEXT', message: 'no org header' },
			});
			await expect(callAnyEndpoint()).rejects.toBeInstanceOf(MissingOrgContextError);
		});

		it('maps 403 NOT_A_MEMBER → NotAMemberError', async () => {
			mockFetchOnce(403, {
				error: { code: 'NOT_A_MEMBER', message: 'no membership' },
			});
			await expect(callAnyEndpoint()).rejects.toBeInstanceOf(NotAMemberError);
		});

		it('maps 403 THUMBNAILS_NOT_AVAILABLE → ThumbnailsNotAvailableError', async () => {
			mockFetchOnce(403, {
				error: {
					code: 'THUMBNAILS_NOT_AVAILABLE',
					message: 'Thumbnails require a paid plan.',
				},
			});
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err).toBeInstanceOf(ThumbnailsNotAvailableError);
			expect(err.code).toBe('THUMBNAILS_NOT_AVAILABLE');
			expect(err.httpStatus).toBe(403);
		});

		it('maps 404 DOCUMENT_NOT_FOUND → DocumentNotFoundError', async () => {
			mockFetchOnce(404, {
				error: { code: 'DOCUMENT_NOT_FOUND', message: 'unknown id' },
			});
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err).toBeInstanceOf(DocumentNotFoundError);
			expect(err.httpStatus).toBe(404);
		});

		it('maps 410 DOCUMENT_GONE → DocumentGoneError', async () => {
			mockFetchOnce(410, {
				error: { code: 'DOCUMENT_GONE', message: 'soft-deleted' },
			});
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err).toBeInstanceOf(DocumentGoneError);
			expect(err.httpStatus).toBe(410);
		});

		it('maps 403 SYSTEM_PROJECT_LOCKED → SystemProjectLockedError', async () => {
			mockFetchOnce(403, {
				error: {
					code: 'SYSTEM_PROJECT_LOCKED',
					message: 'getting-started is read-only',
				},
			});
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err).toBeInstanceOf(SystemProjectLockedError);
			expect(err.httpStatus).toBe(403);
		});

		it('maps 403 SYSTEM_PROJECT_IMMUTABLE → SystemProjectImmutableError', async () => {
			mockFetchOnce(403, {
				error: {
					code: 'SYSTEM_PROJECT_IMMUTABLE',
					message: 'cannot rename system project',
				},
			});
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err).toBeInstanceOf(SystemProjectImmutableError);
			expect(err.httpStatus).toBe(403);
		});
	});

	describe('fallback for unmapped errors', () => {
		it('throws a generic ApiError when the code is unknown', async () => {
			mockFetchOnce(500, {
				error: { code: 'INTERNAL_ERROR', message: 'oops' },
			});
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err).toBeInstanceOf(ApiError);
			expect(err.code).toBe('INTERNAL_ERROR');
			expect(err.httpStatus).toBe(500);
		});

		it('throws a generic ApiError when the body is not JSON', async () => {
			mockFetchOnce(500, 'plain text body');
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err).toBeInstanceOf(ApiError);
			expect(err.httpStatus).toBe(500);
			expect(err.message).toMatch(/plain text body/);
		});
	});

	describe('network failure (fetch threw)', () => {
		it('wraps a fetch TypeError with a readable message exposing URL + cause', async () => {
			const cause = new Error('getaddrinfo ENOTFOUND api.poli.page');
			(cause as Error & { code?: string }).code = 'ENOTFOUND';
			const fetchErr = new TypeError('fetch failed', { cause });
			vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchErr));

			const err = await callAnyEndpoint().catch((e) => e);
			expect(err).toBeInstanceOf(Error);
			expect(err.message).toMatch(/Cannot reach the API/i);
			expect(err.message).toMatch(/api\.test/);
			expect(err.message).toMatch(/ENOTFOUND/);
		});

		it('still wraps when the cause has no code', async () => {
			const fetchErr = new TypeError('fetch failed', {
				cause: new Error('something low-level'),
			});
			vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchErr));

			const err = await callAnyEndpoint().catch((e) => e);
			expect(err.message).toMatch(/Cannot reach the API/i);
			expect(err.message).toMatch(/something low-level/);
		});

		it('passes through non-fetch errors unchanged', async () => {
			const original = new Error('something else');
			vi.stubGlobal('fetch', vi.fn().mockRejectedValue(original));

			const err = await callAnyEndpoint().catch((e) => e);
			expect(err).toBe(original);
		});
	});
});
