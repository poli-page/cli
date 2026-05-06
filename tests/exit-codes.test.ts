import { describe, it, expect } from 'vitest';
import { ExitCode, errorToExitCode } from '../src/exit-codes.js';
import {
	NotAMemberError,
	OrgCancelledError,
	OrgMigratingError,
	SystemProjectLockedError,
	ThumbnailsNotAvailableError,
	InvalidVersionFormatError,
	DocumentNotFoundError,
	ApiError,
} from '../src/api-client.js';

describe('ExitCode constants (cli-spec §1.2)', () => {
	it('matches the spec table values', () => {
		expect(ExitCode.SUCCESS).toBe(0);
		expect(ExitCode.INCONSISTENT).toBe(1);
		expect(ExitCode.INVALID_USAGE).toBe(2);
		expect(ExitCode.NETWORK_OR_API_ERROR).toBe(3);
		expect(ExitCode.NOT_AUTHENTICATED).toBe(4);
		expect(ExitCode.NOT_AUTHORIZED).toBe(5);
		expect(ExitCode.INVALID_LOCAL_STATE).toBe(6);
	});

	it('values are unique', () => {
		const values = Object.values(ExitCode);
		const unique = new Set(values);
		expect(unique.size).toBe(values.length);
	});
});

describe('errorToExitCode', () => {
	it('honours an explicit exitCode on the error (sentinel pattern)', () => {
		const err = Object.assign(new Error('TTY required'), { exitCode: 2 });
		expect(errorToExitCode(err)).toBe(2);
	});

	it('returns NOT_AUTHORIZED (5) for NotAMemberError', () => {
		expect(errorToExitCode(new NotAMemberError('not member'))).toBe(
			ExitCode.NOT_AUTHORIZED
		);
	});

	it('returns NOT_AUTHORIZED (5) for OrgCancelledError', () => {
		expect(errorToExitCode(new OrgCancelledError('cancelled'))).toBe(
			ExitCode.NOT_AUTHORIZED
		);
	});

	it('returns NOT_AUTHORIZED (5) for SystemProjectLockedError', () => {
		expect(errorToExitCode(new SystemProjectLockedError('system'))).toBe(
			ExitCode.NOT_AUTHORIZED
		);
	});

	it('returns NOT_AUTHORIZED (5) for ThumbnailsNotAvailableError (free tier)', () => {
		expect(errorToExitCode(new ThumbnailsNotAvailableError('paid only'))).toBe(
			ExitCode.NOT_AUTHORIZED
		);
	});

	it('returns NETWORK_OR_API_ERROR (3) for OrgMigratingError', () => {
		expect(errorToExitCode(new OrgMigratingError('migrating'))).toBe(
			ExitCode.NETWORK_OR_API_ERROR
		);
	});

	it('returns INVALID_USAGE (2) for InvalidVersionFormatError', () => {
		expect(
			errorToExitCode(new InvalidVersionFormatError('bad format'))
		).toBe(ExitCode.INVALID_USAGE);
	});

	it('returns INVALID_USAGE (2) for DocumentNotFoundError', () => {
		expect(errorToExitCode(new DocumentNotFoundError('not found'))).toBe(
			ExitCode.INVALID_USAGE
		);
	});

	it('returns INVALID_LOCAL_STATE (6) for "not linked" message', () => {
		expect(
			errorToExitCode(new Error("This folder isn't linked to a cloud project."))
		).toBe(ExitCode.INVALID_LOCAL_STATE);
	});

	it('returns NOT_AUTHENTICATED (4) for "Not logged in" message', () => {
		expect(
			errorToExitCode(new Error('Not logged in. Run `poli login` or set POLI_PAGE_API_KEY.'))
		).toBe(ExitCode.NOT_AUTHENTICATED);
	});

	it('returns NETWORK_OR_API_ERROR (3) for generic ApiError', () => {
		expect(
			errorToExitCode(new ApiError('UNKNOWN', 500, 'oops'))
		).toBe(ExitCode.NETWORK_OR_API_ERROR);
	});

	it('returns INCONSISTENT (1) for unrecognised plain Error', () => {
		expect(errorToExitCode(new Error('something weird'))).toBe(
			ExitCode.INCONSISTENT
		);
	});

	it('returns INCONSISTENT (1) for non-Error throws', () => {
		expect(errorToExitCode('a string')).toBe(ExitCode.INCONSISTENT);
		expect(errorToExitCode(42)).toBe(ExitCode.INCONSISTENT);
	});
});
