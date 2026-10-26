import { readCredentials } from './credentials.js';

export type AuthContext =
	| { mode: 'session'; authorization: string; orgIdHeader: string }
	| {
			mode: 'api-key';
			authorization: string;
			orgIdHeader?: undefined;
			/** The environment the key is bound to, read from its prefix (K1). */
			environment: string;
	  };

export interface ResolveAuthOptions {
	manifestOrgId?: string;
	homeDir?: string;
}

// `pp_{environment}_{32 lowercase hex}`, the full-key regex the API publishes
// for clients; the lookahead caps the environment name at 20 characters.
const API_KEY = /^pp_(?=[a-z][a-z0-9-]{0,19}_)[a-z][a-z0-9]*(?:-[a-z0-9]+)*_[0-9a-f]{32}$/;

export async function resolveAuth(options: ResolveAuthOptions = {}): Promise<AuthContext> {
	const credentials = await readCredentials(options.homeDir);

	if (credentials?.session) {
		if (!options.manifestOrgId) {
			throw new Error("This folder isn't linked to a cloud project. Run `poli link` first.");
		}
		return {
			mode: 'session',
			authorization: `Bearer ${credentials.session}`,
			orgIdHeader: options.manifestOrgId,
		};
	}

	const envKey = process.env.POLI_PAGE_API_KEY;
	if (envKey) {
		if (!API_KEY.test(envKey)) {
			throw new Error(
				'POLI_PAGE_API_KEY must be a Poli Page API key: `pp_<environment>_…` (e.g. `pp_sandbox_…`, `pp_live_…`), the environment name followed by 32 lowercase hex characters.'
			);
		}
		return {
			mode: 'api-key',
			authorization: `Bearer ${envKey}`,
			environment: envKey.slice('pp_'.length, envKey.indexOf('_', 'pp_'.length)),
		};
	}

	throw new Error('Not logged in. Run `poli login` or set POLI_PAGE_API_KEY.');
}
