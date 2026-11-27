import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CloudLinkMismatchError,
	forgetLink,
	isLinkConfirmed,
	recordLink,
	verifyCloudLink,
} from '../src/cloud-link.js';
import { ExitCode, errorToExitCode } from '../src/exit-codes.js';
import { createFakeApiClient } from './helpers/fake-api-client.js';

describe('confirmed links (~/.polipage/links.json)', () => {
	let root: string;
	let fakeHome: string;
	let folder: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'poli-links-'));
		fakeHome = join(root, 'home');
		folder = join(root, 'project');
		await mkdir(folder);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const linksPath = () => join(fakeHome, '.polipage', 'links.json');

	it('confirms nothing before any link is recorded', async () => {
		expect(await isLinkConfirmed(folder, 'proj_1', fakeHome)).toBe(false);
	});

	it('confirms the recorded folder for its projectId only', async () => {
		await recordLink(folder, 'proj_1', fakeHome);
		expect(await isLinkConfirmed(folder, 'proj_1', fakeHome)).toBe(true);
		expect(await isLinkConfirmed(folder, 'proj_2', fakeHome)).toBe(false);
	});

	it('keys the folder by its realpath, so a symlinked path is the same folder', async () => {
		const alias = join(root, 'alias');
		await symlink(folder, alias);
		await recordLink(alias, 'proj_1', fakeHome);
		expect(await isLinkConfirmed(folder, 'proj_1', fakeHome)).toBe(true);
	});

	it('confirms nothing when the file holds no links object', async () => {
		await mkdir(join(fakeHome, '.polipage'), { recursive: true });
		await writeFile(linksPath(), JSON.stringify([await realpath(folder)]));
		expect(await isLinkConfirmed(folder, 'proj_1', fakeHome)).toBe(false);
	});

	it('replaces a links array with a record that keeps the new link', async () => {
		await mkdir(join(fakeHome, '.polipage'), { recursive: true });
		await writeFile(linksPath(), JSON.stringify({ links: [] }));
		await recordLink(folder, 'proj_1', fakeHome);
		expect(await isLinkConfirmed(folder, 'proj_1', fakeHome)).toBe(true);
	});

	it('fails on a links file it cannot read instead of asking again', async () => {
		await mkdir(linksPath(), { recursive: true });
		await expect(isLinkConfirmed(folder, 'proj_1', fakeHome)).rejects.toThrow(/EISDIR/);
	});

	it('keeps the links of other folders', async () => {
		const other = join(root, 'other');
		await mkdir(other);
		await recordLink(folder, 'proj_1', fakeHome);
		await recordLink(other, 'proj_2', fakeHome);
		expect(await isLinkConfirmed(folder, 'proj_1', fakeHome)).toBe(true);
		expect(await isLinkConfirmed(other, 'proj_2', fakeHome)).toBe(true);
	});

	it('forgets one folder and keeps the others', async () => {
		const other = join(root, 'other');
		await mkdir(other);
		await recordLink(folder, 'proj_1', fakeHome);
		await recordLink(other, 'proj_2', fakeHome);

		await forgetLink(folder, fakeHome);

		expect(await isLinkConfirmed(folder, 'proj_1', fakeHome)).toBe(false);
		expect(await isLinkConfirmed(other, 'proj_2', fakeHome)).toBe(true);
	});

	it('forgets nothing, and writes no file, when no link is recorded', async () => {
		await forgetLink(folder, fakeHome);
		await expect(readFile(linksPath(), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('treats a corrupt file as confirming nothing, and rewrites it on the next link', async () => {
		await mkdir(join(fakeHome, '.polipage'), { recursive: true });
		await writeFile(linksPath(), '{not json');
		expect(await isLinkConfirmed(folder, 'proj_1', fakeHome)).toBe(false);

		await recordLink(folder, 'proj_1', fakeHome);
		expect(JSON.parse(await readFile(linksPath(), 'utf-8')).links).toEqual({
			[await realpath(folder)]: 'proj_1',
		});
	});
});

describe('verifyCloudLink', () => {
	const client = createFakeApiClient({
		getOrganizations: async () => [{ id: 'org_1', name: 'Acme', slug: 'acme' }],
		listProjects: async () => [{ id: 'proj_1', name: 'Invoices', slug: 'invoices' }],
	});

	it('accepts a legacy cloud block with neither orgId nor projectSlug', async () => {
		await expect(
			verifyCloudLink(client, 'sess', { orgSlug: 'acme', projectId: 'proj_1' })
		).resolves.toEqual({
			org: { id: 'org_1', name: 'Acme', slug: 'acme' },
			project: { id: 'proj_1', name: 'Invoices', slug: 'invoices' },
		});
	});

	it('refuses an orgSlug the user has no organization for, as invalid local state', async () => {
		const err = await verifyCloudLink(client, 'sess', {
			orgSlug: 'other',
			projectId: 'proj_1',
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CloudLinkMismatchError);
		expect((err as Error).message).toBe('Organization "other" not found.');
		expect(errorToExitCode(err)).toBe(ExitCode.INVALID_LOCAL_STATE);
	});

	describe('prints manifest and server text on one line', () => {
		const escClient = createFakeApiClient({
			getOrganizations: async () => [{ id: 'org_1', name: 'Acme', slug: 'ac\u001bme' }],
			listProjects: async () => [{ id: 'proj_1', name: 'Invoices', slug: 'inv\u001b[2Joices' }],
		});
		const messageOf = (cloud: Parameters<typeof verifyCloudLink>[2]) =>
			verifyCloudLink(escClient, 'sess', cloud).then(
				() => '',
				(e: unknown) => (e as Error).message
			);

		it('in the orgSlug of an unknown organization', async () => {
			expect(await messageOf({ orgSlug: 'ot\nher', projectId: 'proj_1' })).toBe(
				'Organization "ot her" not found.'
			);
		});

		it('in the organization slug of an orgId mismatch', async () => {
			expect(
				await messageOf({ orgSlug: 'ac\u001bme', orgId: 'org_2', projectId: 'proj_1' })
			).toContain('orgId "org_2" is not organization "ac me" (org_1)');
		});

		it('in the organization slug of an unknown projectId', async () => {
			expect(await messageOf({ orgSlug: 'ac\u001bme', projectId: 'proj_2' })).toContain(
				'projectId "proj_2" is not a project of "ac me"'
			);
		});

		it('in both slugs of a projectSlug mismatch', async () => {
			expect(
				await messageOf({ orgSlug: 'ac\u001bme', projectId: 'proj_1', projectSlug: 'x\ny' })
			).toContain('projectSlug "x y" is not project "proj_1" (inv [2Joices)');
		});
	});
});
