/**
 * Centralised exit code values for `poli` commands.
 *
 * The semantics mirror cli-spec.md §1.2. Use these constants in command
 * handlers — never hardcode `process.exitCode = 1` in a new place.
 *
 * Special cases:
 *   - SUCCESS (0) is the default; `process.exitCode` does not need to be
 *     set explicitly when a command returns normally.
 *   - INCONSISTENT (1) is used for recoverable user errors where the
 *     current state already satisfies the request (e.g. already logged in,
 *     already linked).
 */
export const ExitCode = {
	SUCCESS: 0,
	INCONSISTENT: 1,
	INVALID_USAGE: 2,
	NETWORK_OR_API_ERROR: 3,
	NOT_AUTHENTICATED: 4,
	NOT_AUTHORIZED: 5,
	INVALID_LOCAL_STATE: 6,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

import {
	ApiError,
	NotAMemberError,
	OrgCancelledError,
	OrgPurgedError,
	OrgMigratingError,
	SystemProjectLockedError,
	SystemProjectImmutableError,
	ThumbnailsNotAvailableError,
	DocumentNotFoundError,
	DocumentGoneError,
	InvalidVersionFormatError,
	InvalidVersionForKeyEnvError,
	VersionRequiredError,
	MissingOrgContextError,
} from './api-client.js';

/**
 * Map a thrown value to a CLI exit code. Use this in command handlers'
 * catch blocks instead of hardcoding `process.exitCode = 1`.
 *
 * Honours an explicit `exitCode` property on the error if present (used
 * by sentinels like TtyRequiredError).
 */
export function errorToExitCode(err: unknown): ExitCodeValue {
	if (err && typeof err === 'object' && 'exitCode' in err) {
		const v = (err as { exitCode?: unknown }).exitCode;
		if (typeof v === 'number') return v as ExitCodeValue;
	}

	if (err instanceof Error) {
		// Auth-domain typed errors map to "not authorised" (insufficient role,
		// org cancelled/purged, system project locked).
		if (
			err instanceof NotAMemberError ||
			err instanceof OrgCancelledError ||
			err instanceof OrgPurgedError ||
			err instanceof SystemProjectLockedError ||
			err instanceof SystemProjectImmutableError ||
			err instanceof ThumbnailsNotAvailableError
		) {
			return ExitCode.NOT_AUTHORIZED;
		}

		// Local state — manifest missing, project not linked, etc.
		if (
			/isn't linked|not linked|poli link first|No poli-page\.json|Are you in a Poli Page project/i.test(
				err.message
			)
		) {
			return ExitCode.INVALID_LOCAL_STATE;
		}

		// Authentication needed.
		if (/Not logged in|POLI_PAGE_API_KEY/i.test(err.message)) {
			return ExitCode.NOT_AUTHENTICATED;
		}

		// Invalid usage — bad args, format errors, validation failures.
		if (
			err instanceof InvalidVersionFormatError ||
			err instanceof InvalidVersionForKeyEnvError ||
			err instanceof VersionRequiredError ||
			err instanceof MissingOrgContextError ||
			err instanceof DocumentNotFoundError ||
			/Invalid version|exact semver|Template .+ not found|template not found|Missing <documentId>/i.test(
				err.message
			)
		) {
			return ExitCode.INVALID_USAGE;
		}

		// Network / API blanket — anything else from the API.
		if (err instanceof ApiError || err instanceof OrgMigratingError) {
			return ExitCode.NETWORK_OR_API_ERROR;
		}

		// Document gone is a transient API-level state; treat as API error
		// rather than user mistake.
		if (err instanceof DocumentGoneError) {
			return ExitCode.NETWORK_OR_API_ERROR;
		}
	}

	return ExitCode.INCONSISTENT;
}
