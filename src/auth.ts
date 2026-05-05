import { readCredentials } from './credentials.js';

export interface AuthContext {
	mode: 'session' | 'api-key';
	authorization: string;
	orgIdHeader?: string;
}

export interface ResolveAuthOptions {
	manifestOrgId?: string;
	homeDir?: string;
}

const API_KEY_PREFIX = 'pp_';

export async function resolveAuth(options: ResolveAuthOptions = {}): Promise<AuthContext> {
	const credentials = await readCredentials(options.homeDir);

	if (credentials?.session) {
		if (!options.manifestOrgId) {
			throw new Error(
				"This folder isn't linked to a cloud project. Run `poli link` first."
			);
		}
		return {
			mode: 'session',
			authorization: `Bearer ${credentials.session}`,
			orgIdHeader: options.manifestOrgId,
		};
	}

	const envKey = process.env.POLI_PAGE_API_KEY;
	if (envKey) {
		if (!envKey.startsWith(API_KEY_PREFIX)) {
			throw new Error(
				'POLI_PAGE_API_KEY must start with `pp_` (e.g. `pp_test_…`, `pp_live_…`, `pp_sa_…`).'
			);
		}
		return {
			mode: 'api-key',
			authorization: `Bearer ${envKey}`,
		};
	}

	throw new Error('Not logged in. Run `poli login` or set POLI_PAGE_API_KEY.');
}
