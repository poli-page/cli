import { readManifest } from './manifest.js';
import { getSessionToken } from './credentials.js';
import { createApiClient, type ApiClient } from './api-client.js';
import { MANIFEST_FILENAME } from './constants.js';

export interface CloudContext {
	session: string;
	orgId: string;
	orgSlug: string;
	projectId: string;
}

export const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;
const PARTIAL_SEMVER = /^\d+(?:\.\d+)?$/;

export function validateExactSemver(version: string): void {
	if (version === 'latest') {
		throw new Error(
			'`latest` was retired. Run `poli versions list` and pin an exact semver like `1.2.3`.'
		);
	}
	if (PARTIAL_SEMVER.test(version)) {
		throw new Error(
			'Use an exact semver `X.Y.Z`. Partial versions like `1.0` were retired.'
		);
	}
	if (!EXACT_SEMVER.test(version)) {
		throw new Error('Invalid version: must be an exact semver `X.Y.Z`.');
	}
}

export async function resolveCloudContext(options: {
	cwd?: string;
	apiClient?: ApiClient;
	homeDir?: string;
}): Promise<{ client: ApiClient; ctx: CloudContext }> {
	const cwd = options.cwd ?? process.cwd();
	const client = options.apiClient ?? createApiClient();
	const session = await getSessionToken(options.homeDir);

	let manifest;
	try {
		manifest = await readManifest(cwd);
	} catch (err) {
		if (err instanceof Error && /ENOENT/.test(err.message)) {
			throw new Error(
				`No ${MANIFEST_FILENAME} found in ${cwd}. Are you in a Poli Page project?`
			);
		}
		throw err;
	}

	if (!manifest.cloud) {
		throw new Error('Project is not linked to any organization. Run "poli link" first.');
	}

	const { orgSlug } = manifest.cloud;
	const orgs = await client.getOrganizations(session);
	const org = orgs.find((o) => o.slug === orgSlug);
	if (!org) {
		throw new Error(`Organization "${orgSlug}" not found.`);
	}

	return {
		client,
		ctx: {
			session,
			orgId: org.id,
			orgSlug,
			projectId: manifest.cloud.projectId,
		},
	};
}
