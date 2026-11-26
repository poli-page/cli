import { readProjectManifest } from './manifest.js';
import { getSessionToken } from './credentials.js';
import { createApiClient, type ApiClient } from './api-client.js';
import { ensureLinkConfirmed, verifyCloudLink, type LinkTarget } from './cloud-link.js';

export interface CloudContext {
	session: string;
	orgId: string;
	orgSlug: string;
	projectId: string;
	projectSlug: string;
}

/**
 * The project `poli dev` / `poli watch` sync to, once the manifest's ids
 * agree and the user has confirmed this folder's link.
 */
export async function resolveCloudContext(options: {
	cwd?: string;
	apiClient?: ApiClient;
	homeDir?: string;
	/** Asks before the first sync of an unconfirmed folder; absent, such a folder is refused. */
	confirmLink?: (target: LinkTarget) => Promise<boolean>;
}): Promise<{ client: ApiClient; ctx: CloudContext }> {
	const cwd = options.cwd ?? process.cwd();
	const client = options.apiClient ?? createApiClient();
	const session = await getSessionToken(options.homeDir);

	const manifest = await readProjectManifest(cwd);

	if (!manifest.cloud) {
		throw new Error('Project is not linked to any organization. Run "poli link" first.');
	}

	const target = await verifyCloudLink(client, session, manifest.cloud);
	await ensureLinkConfirmed(cwd, target, {
		homeDir: options.homeDir,
		confirmLink: options.confirmLink,
	});

	return {
		client,
		ctx: {
			session,
			orgId: target.org.id,
			orgSlug: target.org.slug,
			projectId: target.project.id,
			projectSlug: target.project.slug,
		},
	};
}
