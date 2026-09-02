import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createProjectSyncer,
	isBinaryAsset,
	readAllProjectFiles,
	shouldIgnoreProjectPath,
} from '../src/project-sync.js';
import type { ApiClient, PatchFilesBody } from '../src/api-client.js';
import type { CloudContext } from '../src/cloud-context.js';

const ctx: CloudContext = {
	session: 'sess',
	orgId: 'org_1',
	orgSlug: 'acme',
	projectId: 'proj_1',
};

function makeClient(bodies: PatchFilesBody[]): ApiClient {
	return {
		patchFiles: async (_session, _orgId, _projectId, body) => {
			bodies.push(body);
			return { syncedAt: '2026-09-01T10:00:00.000Z' };
		},
	} as unknown as ApiClient;
}

describe('shouldIgnoreProjectPath', () => {
	it('skips build output, VCS metadata and noise', () => {
		expect(shouldIgnoreProjectPath('node_modules/x/index.js')).toBe(true);
		expect(shouldIgnoreProjectPath('.git/HEAD')).toBe(true);
		expect(shouldIgnoreProjectPath('output/invoice/a4-portrait/invoice.pdf')).toBe(true);
		expect(shouldIgnoreProjectPath('dist/index.js')).toBe(true);
		expect(shouldIgnoreProjectPath('templates/.DS_Store')).toBe(true);
		expect(shouldIgnoreProjectPath('debug.log')).toBe(true);
	});

	it('keeps project sources', () => {
		expect(shouldIgnoreProjectPath('templates/invoice/invoice.html')).toBe(false);
		expect(shouldIgnoreProjectPath('tailwind.css')).toBe(false);
	});
});

describe('isBinaryAsset', () => {
	it('flags images and fonts', () => {
		for (const path of ['a.png', 'a.svg', 'a.woff2', 'a.OTF']) {
			expect(isBinaryAsset(path)).toBe(true);
		}
	});

	it('leaves text sources alone', () => {
		for (const path of ['a.html', 'a.json', 'a.css', 'noextension']) {
			expect(isBinaryAsset(path)).toBe(false);
		}
	});
});

describe('createProjectSyncer', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'poli-sync-'));
		await mkdir(join(dir, 'templates', 'invoice'), { recursive: true });
		await writeFile(join(dir, 'templates', 'invoice', 'invoice.html'), '<h1>v1</h1>');
		await writeFile(join(dir, 'tailwind.css'), 'body{}');
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('reads every syncable file with POSIX paths', async () => {
		const files = await readAllProjectFiles(dir);
		expect([...files.keys()].sort()).toEqual([
			'tailwind.css',
			'templates/invoice/invoice.html',
		]);
	});

	it('prime() takes a snapshot without pushing anything', async () => {
		const bodies: PatchFilesBody[] = [];
		const syncer = createProjectSyncer({ cwd: dir, client: makeClient(bodies), ctx });

		expect(await syncer.prime()).toBe(2);
		expect(bodies).toHaveLength(0);
		expect(syncer.trackedCount).toBe(2);
	});

	it('sync() pushes only the delta and reports the changed paths', async () => {
		const bodies: PatchFilesBody[] = [];
		const syncer = createProjectSyncer({ cwd: dir, client: makeClient(bodies), ctx });
		await syncer.prime();

		const unchanged = await syncer.sync();
		expect(unchanged.changed).toBe(false);
		expect(bodies).toHaveLength(0);

		await writeFile(join(dir, 'templates', 'invoice', 'invoice.html'), '<h1>v2</h1>');
		await writeFile(join(dir, 'new.json'), '{}');
		const changed = await syncer.sync();

		expect(changed.changed).toBe(true);
		expect(changed.syncedAt).toBe('2026-09-01T10:00:00.000Z');
		expect(changed.changedPaths.sort()).toEqual(['new.json', 'templates/invoice/invoice.html']);
		expect(bodies).toHaveLength(1);
		expect(bodies[0].added.map((e) => e.path)).toEqual(['new.json']);
		expect(bodies[0].modified.map((e) => e.path)).toEqual(['templates/invoice/invoice.html']);
	});

	it('syncAll() pushes the whole tree as modified and reseeds the snapshot', async () => {
		const bodies: PatchFilesBody[] = [];
		const syncer = createProjectSyncer({ cwd: dir, client: makeClient(bodies), ctx });

		const outcome = await syncer.syncAll();
		expect(outcome.changed).toBe(true);
		expect(bodies).toHaveLength(1);
		expect(bodies[0].added).toEqual([]);
		expect(bodies[0].deleted).toEqual([]);
		expect(bodies[0].modified.map((e) => e.path).sort()).toEqual([
			'tailwind.css',
			'templates/invoice/invoice.html',
		]);

		// The snapshot is now current: an immediate delta sync is a no-op.
		const following = await syncer.sync();
		expect(following.changed).toBe(false);
		expect(bodies).toHaveLength(1);
	});

	it('base64-encodes binary assets on the wire', async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x80, 0x00, 0xab]);
		await mkdir(join(dir, 'assets', 'images'), { recursive: true });
		await writeFile(join(dir, 'assets', 'images', 'logo.png'), bytes);

		const bodies: PatchFilesBody[] = [];
		const syncer = createProjectSyncer({ cwd: dir, client: makeClient(bodies), ctx });
		await syncer.syncAll();

		const entry = bodies[0].modified.find((e) => e.path === 'assets/images/logo.png');
		expect(entry).toBeDefined();
		expect(Buffer.from(entry!.content, 'base64').equals(bytes)).toBe(true);
	});

	it('reports deletions', async () => {
		const bodies: PatchFilesBody[] = [];
		const syncer = createProjectSyncer({ cwd: dir, client: makeClient(bodies), ctx });
		await syncer.prime();

		await rm(join(dir, 'tailwind.css'));
		const outcome = await syncer.sync();

		expect(outcome.changedPaths).toEqual(['tailwind.css']);
		expect(bodies[0].deleted).toEqual(['tailwind.css']);
	});
});

describe('shouldIgnoreProjectPath — API allowlist', () => {
	it.each([
		'poli-page.json',
		'tailwind.css',
		'templates/invoice/invoice.html',
		'templates/invoice/invoice.json',
		'partials/header.html',
		'assets/fonts/dm-sans.woff2',
		'assets/images/logo.svg',
	])('syncs %s', (path) => {
		expect(shouldIgnoreProjectPath(path)).toBe(false);
	});

	// The API refuses anything outside its allowlist with a 400, which fails
	// the whole batch. `.gitignore` and `.prettierignore` are scaffolded by
	// `poli init` itself, so every project carries them.
	it.each([
		'.gitignore',
		'.prettierignore',
		'README.md',
		'.env',
		'templates/invoice/invoice.json.scaffold.bak',
		'styles.css',
		'notes.txt',
	])('skips %s', (path) => {
		expect(shouldIgnoreProjectPath(path)).toBe(true);
	});
});
