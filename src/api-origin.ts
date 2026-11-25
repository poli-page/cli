import { UsageError } from './exit-codes.js';

export const DEFAULT_API_URL = 'https://api.poli.page';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

export function insecureApiAllowed(): boolean {
	return process.env.POLI_ALLOW_INSECURE_API === '1';
}

/**
 * The origin of `url` when the CLI may send credentials there: `https:` on
 * `poli.page` or a subdomain, or loopback with the explicit opt-in. Anything
 * else is a UsageError (exit 2), thrown before a request is made.
 */
export function assertTrustedApiOrigin(url: string, allowInsecure = insecureApiAllowed()): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new UsageError(`Invalid API URL: expected an origin like ${DEFAULT_API_URL}.`);
	}
	// A string check on a URL with userinfo, a path, a query or a hash is not a
	// check on the host it resolves to. The raw URL stays out of the message:
	// those parts may hold a token.
	if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
		throw new UsageError(
			`The API URL must be an origin only (scheme, host and port), like ${DEFAULT_API_URL}.`
		);
	}
	const host = parsed.hostname;
	if (parsed.protocol === 'https:' && (host === 'poli.page' || host.endsWith('.poli.page'))) {
		return parsed.origin;
	}
	if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && LOOPBACK_HOSTS.has(host)) {
		if (allowInsecure) return parsed.origin;
		throw new UsageError(
			`API URL "${parsed.origin}" is a local address: pass --allow-insecure-api or set POLI_ALLOW_INSECURE_API=1 to use it.`
		);
	}
	throw new UsageError(
		`API URL "${parsed.origin}" is not a Poli Page API: credentials are only sent to https://poli.page or https://*.poli.page.`
	);
}

/** The validated origin of the API this run talks to. */
export function apiOrigin(): string {
	return assertTrustedApiOrigin(process.env.POLI_API_URL || DEFAULT_API_URL);
}
