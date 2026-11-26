import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiClient } from './api-client.js';
import { getCredentialsDir, writePrivateFile } from './credentials.js';
import { LINKS_FILENAME } from './constants.js';
import { ExitCode } from './exit-codes.js';
import type { PoliPageManifest } from './manifest.schema.js';
import { confirmPrompt } from './template-prompt.js';

export type CloudBlock = NonNullable<PoliPageManifest['cloud']>;

export interface LinkTarget {
	org: { id: string; name: string; slug: string };
	project: { id: string; name: string; slug: string };
}

export class CloudLinkMismatchError extends Error {
	readonly exitCode = ExitCode.INVALID_LOCAL_STATE;
}

export class UnconfirmedLinkError extends Error {
	readonly exitCode = ExitCode.INVALID_USAGE;
}

function describeTarget({ org, project }: LinkTarget): string {
	return `project "${project.name}" (${project.slug}) of organization "${org.name}" (${org.slug})`;
}

function mismatch(detail: string): CloudLinkMismatchError {
	return new CloudLinkMismatchError(
		`The cloud block of poli-page.json names more than one project: ${detail}. Run \`poli unlink\`, then \`poli link\`.`
	);
}

/**
 * Sync writes to `projectId` in `orgSlug`'s organization while publish and
 * render address `projectSlug` with `orgId`: refuse a manifest whose ids do
 * not all name the same project, so no command writes somewhere else.
 */
export async function verifyCloudLink(
	client: ApiClient,
	session: string,
	cloud: CloudBlock
): Promise<LinkTarget> {
	const orgs = await client.getOrganizations(session);
	const org = orgs.find((o) => o.slug === cloud.orgSlug);
	if (!org) {
		throw new CloudLinkMismatchError(`Organization "${cloud.orgSlug}" not found.`);
	}
	if (cloud.orgId !== undefined && cloud.orgId !== org.id) {
		throw mismatch(`orgId "${cloud.orgId}" is not organization "${org.slug}" (${org.id})`);
	}

	const projects = await client.listProjects(session, org.id);
	const project = projects.find((p) => p.id === cloud.projectId);
	if (!project) {
		throw mismatch(`projectId "${cloud.projectId}" is not a project of "${org.slug}"`);
	}
	if (cloud.projectSlug !== undefined && cloud.projectSlug !== project.slug) {
		throw mismatch(
			`projectSlug "${cloud.projectSlug}" is not project "${project.id}" (${project.slug})`
		);
	}
	return { org, project };
}

/** Confirmed links: folder realpath → the projectId the user confirmed for it. */
async function readLinks(homeDir?: string): Promise<Record<string, unknown>> {
	let content: string;
	try {
		content = await readFile(join(getCredentialsDir(homeDir), LINKS_FILENAME), 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw error;
	}
	try {
		const parsed: unknown = JSON.parse(content);
		const links = (parsed as { links?: unknown } | null)?.links;
		if (!links || typeof links !== 'object' || Array.isArray(links)) return {};
		return links as Record<string, unknown>;
	} catch {
		// A corrupt file confirms nothing: every folder asks again.
		return {};
	}
}

export async function isLinkConfirmed(
	dir: string,
	projectId: string,
	homeDir?: string
): Promise<boolean> {
	const links = await readLinks(homeDir);
	const folder = await realpath(dir);
	return links[folder] === projectId;
}

export async function recordLink(dir: string, projectId: string, homeDir?: string): Promise<void> {
	const links = await readLinks(homeDir);
	links[await realpath(dir)] = projectId;
	await writePrivateFile(LINKS_FILENAME, JSON.stringify({ links }, null, '\t') + '\n', homeDir);
}

export async function forgetLink(dir: string, homeDir?: string): Promise<void> {
	const links = await readLinks(homeDir);
	const folder = await realpath(dir);
	if (!(folder in links)) return;
	delete links[folder];
	await writePrivateFile(LINKS_FILENAME, JSON.stringify({ links }, null, '\t') + '\n', homeDir);
}

/**
 * A cloud block can come from a cloned repository: before the first sync of
 * a folder this user has not linked, name the target and ask, or refuse.
 */
export async function ensureLinkConfirmed(
	dir: string,
	target: LinkTarget,
	options: { homeDir?: string; confirmLink?: (target: LinkTarget) => Promise<boolean> }
): Promise<void> {
	if (await isLinkConfirmed(dir, target.project.id, options.homeDir)) return;
	if (!options.confirmLink) {
		throw new UnconfirmedLinkError(
			`This folder is linked to ${describeTarget(target)}, a link you have not confirmed on this machine. Run the command in a terminal to confirm it, or run \`poli unlink\`, then \`poli link\`.`
		);
	}
	if (!(await options.confirmLink(target))) {
		throw new Error('Sync cancelled: the link was not confirmed.');
	}
	await recordLink(dir, target.project.id, options.homeDir);
}

export function confirmLinkPrompt(target: LinkTarget): Promise<boolean> {
	return confirmPrompt({
		message: `Sync this folder to ${describeTarget(target)}? Each sync overwrites that project's cloud draft.`,
		default: false,
	});
}

export function confirmExistingProjectPrompt(target: LinkTarget): Promise<boolean> {
	return confirmPrompt({
		message: `Link this folder to the existing ${describeTarget(target)}? Each sync overwrites that project's cloud draft.`,
		default: false,
	});
}
