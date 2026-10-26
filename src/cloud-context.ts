import { readProjectManifest } from './manifest.js';
import { getSessionToken } from './credentials.js';
import { createApiClient, type ApiClient } from './api-client.js';

export interface CloudContext {
	session: string;
	orgId: string;
	orgSlug: string;
	projectId: string;
}

export async function resolveCloudContext(options: {
	cwd?: string;
	apiClient?: ApiClient;
	homeDir?: string;
}): Promise<{ client: ApiClient; ctx: CloudContext }> {
	const cwd = options.cwd ?? process.cwd();
	const client = options.apiClient ?? createApiClient();
	const session = await getSessionToken(options.homeDir);

	const manifest = await readProjectManifest(cwd);

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
