import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	createApiClient,
	ApiError,
	QuotaExceededError,
	OverageCapError,
	OrgPaymentGraceError,
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
	InvalidTrackFormatError,
	VersionConflictError,
} from '../src/api-client.js';
import { ExitCode, errorToExitCode } from '../src/exit-codes.js';
import realResponses from './fixtures/api-error-responses.json';

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

/**
 * The API error envelope (api-spec §4.1, `packages/api/src/middleware/error-handler.ts`):
 * the code is a string in `error`, the human-readable reason is the optional `detail`.
 */
function envelope(code: string, detail?: string) {
	return {
		error: code,
		...(detail !== undefined ? { detail } : {}),
		requestId: 'req-test',
	};
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
		it('maps 429 QUOTA_EXCEEDED → QuotaExceededError, message from detail, Retry-After', async () => {
			mockFetchOnce(429, envelope('QUOTA_EXCEEDED', 'Free plan: 100/mo'), {
				'Retry-After': '12345',
			});
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err).toBeInstanceOf(QuotaExceededError);
			expect(err).toBeInstanceOf(ApiError);
			expect(err.code).toBe('QUOTA_EXCEEDED');
			expect(err.httpStatus).toBe(429);
			expect(err.retryAfter).toBe(12345);
			expect(err.message).toBe('Free plan: 100/mo');
		});

		const typedCases: Array<[string, number, new (message: string) => ApiError]> = [
			['QUOTA_EXCEEDED', 429, QuotaExceededError],
			['OVERAGE_CAP_EXCEEDED', 429, OverageCapError],
			['ORGANIZATION_PAYMENT_GRACE', 403, OrgPaymentGraceError],
			['ORGANIZATION_CANCELLED', 403, OrgCancelledError],
			['ORGANIZATION_PURGED', 410, OrgPurgedError],
			['ORGANIZATION_MIGRATING', 503, OrgMigratingError],
			['INVALID_VERSION_FORMAT', 400, InvalidVersionFormatError],
			['INVALID_VERSION_FOR_KEY_ENV', 400, InvalidVersionForKeyEnvError],
			['VERSION_REQUIRED', 400, VersionRequiredError],
			['MISSING_ORG_CONTEXT', 400, MissingOrgContextError],
			['NOT_A_MEMBER', 403, NotAMemberError],
			['THUMBNAILS_NOT_AVAILABLE', 403, ThumbnailsNotAvailableError],
			['DOCUMENT_NOT_FOUND', 404, DocumentNotFoundError],
			['DOCUMENT_GONE', 410, DocumentGoneError],
			['SYSTEM_PROJECT_LOCKED', 403, SystemProjectLockedError],
			['SYSTEM_PROJECT_IMMUTABLE', 403, SystemProjectImmutableError],
			['INVALID_TRACK_FORMAT', 400, InvalidTrackFormatError],
			['VERSION_CONFLICT', 409, VersionConflictError],
		];

		it.each(typedCases)(
			'maps %s (%i) with a detail → typed error carrying the detail',
			async (code, status, ctor) => {
				mockFetchOnce(status, envelope(code, `why ${code} happened`));
				const err = await callAnyEndpoint().catch((e) => e);
				expect(err).toBeInstanceOf(ctor);
				expect(err.code).toBe(code);
				expect(err.httpStatus).toBe(status);
				expect(err.message).toBe(`why ${code} happened`);
			}
		);

		it.each(typedCases)(
			'maps %s (%i) without a detail → typed error, message names status + code',
			async (code, status, ctor) => {
				mockFetchOnce(status, envelope(code));
				const err = await callAnyEndpoint().catch((e) => e);
				expect(err).toBeInstanceOf(ctor);
				expect(err.message).toBe(`${status} ${code}`);
			}
		);

		it('has no typed class for PAYMENT_REQUIRED: the payment-grace block is 403 ORGANIZATION_PAYMENT_GRACE (#399)', async () => {
			mockFetchOnce(402, envelope('PAYMENT_REQUIRED'));
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err.constructor).toBe(ApiError);
			expect(err.code).toBe('PAYMENT_REQUIRED');
			expect(err.httpStatus).toBe(402);
		});

		it('a typed error built from the real envelope reaches its documented exit code', async () => {
			mockFetchOnce(403, envelope('NOT_A_MEMBER'));
			const err = await callAnyEndpoint().catch((e) => e);
			expect(errorToExitCode(err)).toBe(ExitCode.NOT_AUTHORIZED);
		});
	});

	describe('fallback for unmapped errors', () => {
		it('throws a generic ApiError carrying the code when the code is unknown', async () => {
			mockFetchOnce(500, envelope('INTERNAL_ERROR', 'An unexpected error occurred'));
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err.constructor).toBe(ApiError);
			expect(err.code).toBe('INTERNAL_ERROR');
			expect(err.httpStatus).toBe(500);
			expect(err.message).toBe('An unexpected error occurred');
		});

		it('appends validation issues to the detail', async () => {
			mockFetchOnce(400, {
				...envelope('VALIDATION_ERROR', 'Request validation failed'),
				issues: { name: ['Too short', 'Bad chars'], slug: ['Required'] },
			});
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err.code).toBe('VALIDATION_ERROR');
			expect(err.message).toBe(
				'Request validation failed: name: Too short, Bad chars; slug: Required'
			);
		});

		it('reads the Better Auth shape { code, message } (/api/auth/* routes)', async () => {
			mockFetchOnce(422, {
				code: 'USER_ALREADY_EXISTS',
				message: 'User already exists. Use another email.',
			});
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err.code).toBe('USER_ALREADY_EXISTS');
			expect(err.httpStatus).toBe(422);
			expect(err.message).toBe('User already exists. Use another email.');
		});

		it('ignores the nested { error: { code } } shape, which no route the CLI calls sends', async () => {
			mockFetchOnce(403, { error: { code: 'NOT_A_MEMBER', message: 'nested' } });
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err).not.toBeInstanceOf(NotAMemberError);
			expect(err.code).toBe('UNKNOWN');
		});

		it('uses a bare { message } body (e.g. an API Gateway error) as the message', async () => {
			mockFetchOnce(503, { message: 'Service Unavailable' });
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err.code).toBe('UNKNOWN');
			expect(err.httpStatus).toBe(503);
			expect(err.message).toBe('Service Unavailable');
		});

		it('throws a generic ApiError when the body is not JSON', async () => {
			mockFetchOnce(500, 'plain text body');
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err).toBeInstanceOf(ApiError);
			expect(err.httpStatus).toBe(500);
			expect(err.message).toMatch(/plain text body/);
		});

		it('names the status when the body is empty', async () => {
			mockFetchOnce(502, '');
			const err = await callAnyEndpoint().catch((e) => e);
			expect(err.code).toBe('UNKNOWN');
			expect(err.message).toBe('HTTP 502');
		});
	});

	describe('real API responses (tests/fixtures/api-error-responses.json, captured from api-develop)', () => {
		it.each(realResponses.responses.map((r) => [r.name, r] as const))(
			'%s',
			async (_name, fixture) => {
				mockFetchOnce(fixture.status, fixture.body);
				const err = await callAnyEndpoint().catch((e) => e);
				expect(err).toBeInstanceOf(ApiError);
				expect(err.code).toBe(fixture.expectedCode);
				expect(err.httpStatus).toBe(fixture.status);
				expect(err.message).toBe(fixture.expectedMessage);
				expect(err.message).not.toMatch(/requestId/);
			}
		);
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
