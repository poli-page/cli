import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink, truncate } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createProjectSyncer,
	listProjectFiles,
	readAllProjectFiles,
	PROJECT_FILE_MAX_BYTES,
	PROJECT_MAX_FILES,
	PROJECT_MAX_TOTAL_BYTES,
} from '../src/project-sync.js';
import { ExitCode, errorToExitCode } from '../src/exit-codes.js';
import type { PatchFilesBody } from '../src/api-client.js';
import { createFakeApiClient } from './helpers/fake-api-client.js';
import { plantImagesOverTotalLimit } from './helpers/over-limit-project.js';

// Pass-through spies: the real filesystem answers, the test sees every call.
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		readdir: vi.fn(actual.readdir),
		readFile: vi.fn(actual.readFile),
		open: vi.fn(actual.open),
		lstat: vi.fn(actual.lstat),
	};
});

const readdirSpy = vi.mocked(fsp.readdir);
const openSpy = vi.mocked(fsp.open);
const readFileSpy = vi.mocked(fsp.readFile);
const lstatSpy = vi.mocked(fsp.lstat);

function pathsOf(spy: { mock: { calls: unknown[][] } }): string[] {
	return spy.mock.calls.map((call) => String(call[0]));
}

describe('project file set walk and limits', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'poli-limits-'));
		await writeFile(join(dir, 'poli-page.json'), '{}');
		await writeFile(join(dir, 'tailwind.css'), 'body{}');
		await mkdir(join(dir, 'templates', 'invoice'), { recursive: true });
		await writeFile(join(dir, 'templates', 'invoice', 'invoice.html'), '<h1>é</h1>');
		await mkdir(join(dir, 'partials'), { recursive: true });
		await writeFile(join(dir, 'partials', 'header.html'), '<header/>');
		await mkdir(join(dir, 'assets', 'images'), { recursive: true });
		await writeFile(join(dir, 'assets', 'images', 'logo.png'), Buffer.from([0x89, 0x50, 0xff]));
		vi.clearAllMocks();
	});

	afterEach(async () => {
		vi.clearAllMocks();
		await rm(dir, { recursive: true, force: true });
	});

	it('syncs the same file set and contents as a full read of the tree', async () => {
		await writeFile(join(dir, 'README.md'), '# notes');
		await mkdir(join(dir, 'assets', 'fonts'), { recursive: true });
		await writeFile(join(dir, 'assets', 'fonts', 'inter.ttf'), Buffer.from([0, 1]));
		await writeFile(join(dir, 'assets', 'fonts', 'readme.txt'), 'x');

		const files = await readAllProjectFiles(dir);
		expect(Object.fromEntries(files)).toEqual({
			'assets/fonts/inter.ttf': Buffer.from([0, 1]).toString('base64'),
			'assets/images/logo.png': Buffer.from([0x89, 0x50, 0xff]).toString('base64'),
			'partials/header.html': '<header/>',
			'poli-page.json': '{}',
			'tailwind.css': 'body{}',
			'templates/invoice/invoice.html': '<h1>é</h1>',
		});
	});

	it('never lists node_modules, .git or a folder outside the project roots', async () => {
		for (const ignored of [
			'node_modules/pkg',
			'.git/objects',
			'output/invoice',
			'dist',
			'docs',
			'templates/invoice/node_modules/pkg',
			'assets/images/.git',
		]) {
			await mkdir(join(dir, ignored), { recursive: true });
			await writeFile(join(dir, ignored, 'x.html'), '<p/>');
		}

		await readAllProjectFiles(dir);

		const listed = pathsOf(readdirSpy);
		expect(listed.length).toBeGreaterThan(0);
		for (const path of listed) {
			expect(path.split(/[\\/]/)).not.toContain('node_modules');
			expect(path.split(/[\\/]/)).not.toContain('.git');
			expect(path.split(/[\\/]/)).not.toContain('output');
			expect(path.split(/[\\/]/)).not.toContain('dist');
			expect(path.split(/[\\/]/)).not.toContain('docs');
		}
		expect(listed).not.toContain(dir);
	});

	it('neither lists nor follows a symlinked project folder or file', async () => {
		const outside = await mkdtemp(join(tmpdir(), 'poli-outside-'));
		try {
			await writeFile(join(outside, 'secret.html'), '<p>secret</p>');
			await mkdir(join(outside, 'images'));
			await writeFile(join(outside, 'images', 'secret.png'), 'secret');
			await symlink(outside, join(dir, 'partials', 'linked'));
			await rm(join(dir, 'assets'), { recursive: true });
			await symlink(outside, join(dir, 'assets'));
			await rm(join(dir, 'tailwind.css'));
			await symlink(join(outside, 'secret.html'), join(dir, 'tailwind.css'));

			const files = await readAllProjectFiles(dir);

			expect([...files.keys()].sort()).toEqual([
				'partials/header.html',
				'poli-page.json',
				'templates/invoice/invoice.html',
			]);
			expect(pathsOf(readdirSpy)).not.toContain(join(dir, 'partials', 'linked'));
			expect(pathsOf(readdirSpy)).not.toContain(join(dir, 'assets'));
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	it('refuses a file over the per-file limit from its stat, without reading it', async () => {
		const huge = join(dir, 'assets', 'images', 'huge.png');
		await writeFile(huge, '');
		await truncate(huge, PROJECT_FILE_MAX_BYTES + 1);

		const err = await readAllProjectFiles(dir).catch((e) => e);

		expect(err.message).toContain('assets/images/huge.png');
		expect(err.message).toContain('4.0 MiB');
		expect(errorToExitCode(err)).toBe(ExitCode.INVALID_USAGE);
		expect(openSpy).not.toHaveBeenCalled();
		expect(readFileSpy).not.toHaveBeenCalled();
	});

	it('accepts a file of exactly the per-file limit', async () => {
		const big = join(dir, 'assets', 'images', 'big.png');
		await writeFile(big, '');
		await truncate(big, PROJECT_FILE_MAX_BYTES);

		const files = await listProjectFiles(dir);
		expect(files.find((f) => f.path === 'assets/images/big.png')?.size).toBe(
			PROJECT_FILE_MAX_BYTES
		);
	});

	it('refuses a project whose files add up to more than the total limit, reading none', async () => {
		const third = Math.ceil(PROJECT_MAX_TOTAL_BYTES / 3);
		for (const name of ['a.png', 'b.png', 'c.png']) {
			await writeFile(join(dir, 'assets', 'images', name), '');
			await truncate(join(dir, 'assets', 'images', name), third);
		}

		const err = await readAllProjectFiles(dir).catch((e) => e);

		expect(err.message).toMatch(/add up to more than 5\.0 MiB/);
		expect(err.message).toContain('assets/images/c.png');
		expect(errorToExitCode(err)).toBe(ExitCode.INVALID_USAGE);
		expect(openSpy).not.toHaveBeenCalled();
	});

	it(`refuses a project of more than ${PROJECT_MAX_FILES} files, reading none`, async () => {
		// 5 files already; this brings the set to PROJECT_MAX_FILES + 1.
		const icons = join(dir, 'assets', 'icons');
		await mkdir(icons);
		await Promise.all(
			Array.from({ length: PROJECT_MAX_FILES - 4 }, (_, i) =>
				writeFile(join(icons, `i${i}.svg`), '<svg/>')
			)
		);

		const err = await readAllProjectFiles(dir).catch((e) => e);

		expect(err.message).toMatch(new RegExp(`more than ${PROJECT_MAX_FILES} files`));
		expect(errorToExitCode(err)).toBe(ExitCode.INVALID_USAGE);
		expect(openSpy).not.toHaveBeenCalled();
	});

	it(`accepts a project of exactly ${PROJECT_MAX_FILES} files`, async () => {
		const icons = join(dir, 'assets', 'icons');
		await mkdir(icons);
		await Promise.all(
			Array.from({ length: PROJECT_MAX_FILES - 5 }, (_, i) =>
				writeFile(join(icons, `i${i}.svg`), '<svg/>')
			)
		);

		expect(await listProjectFiles(dir)).toHaveLength(PROJECT_MAX_FILES);
	});

	it('sends nothing, not even the files within the limits, once a sync passes one', async () => {
		const bodies: PatchFilesBody[] = [];
		const client = createFakeApiClient({
			patchFiles: async (_session, _orgId, _projectId, body) => {
				bodies.push(body);
				return { syncedAt: '2026-11-27T10:00:00.000Z' };
			},
		});
		const ctx = { session: 's', orgId: 'o', orgSlug: 'acme', projectId: 'p', projectSlug: 'demo' };
		const syncer = createProjectSyncer({ cwd: dir, client, ctx });
		await syncer.prime();

		await writeFile(join(dir, 'tailwind.css'), 'body{color:red}');
		await plantImagesOverTotalLimit(dir);

		await expect(syncer.sync()).rejects.toMatchObject({ exitCode: ExitCode.INVALID_USAGE });
		await expect(syncer.syncAll()).rejects.toMatchObject({ exitCode: ExitCode.INVALID_USAGE });
		expect(bodies).toHaveLength(0);
	});

	it('does not follow a file swapped for a symlink after the listing', async () => {
		const outside = await mkdtemp(join(tmpdir(), 'poli-outside-'));
		try {
			await writeFile(join(outside, 'secret.html'), '<p>secret</p>');
			const target = join(dir, 'partials', 'footer.html');
			await symlink(join(outside, 'secret.html'), target);
			// The listing saw a regular file there; the swap happened since.
			const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
			lstatSpy.mockImplementation(async (path, ...rest) =>
				String(path) === target
					? actual.stat(path)
					: actual.lstat(path, ...(rest as []))
			);

			await expect(readAllProjectFiles(dir)).rejects.toMatchObject({ code: 'ELOOP' });
		} finally {
			lstatSpy.mockReset();
			lstatSpy.mockImplementation(
				(await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).lstat as never
			);
			await rm(outside, { recursive: true, force: true });
		}
	});

	it('refuses a file that grew past the limit after the listing', async () => {
		const grown = join(dir, 'assets', 'images', 'grown.png');
		await writeFile(grown, '');
		await truncate(grown, PROJECT_FILE_MAX_BYTES + 1);
		const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
		lstatSpy.mockImplementation(async (path, ...rest) => {
			const stats = await actual.lstat(path, ...(rest as []));
			if (String(path) === grown) Object.defineProperty(stats, 'size', { value: 1 });
			return stats;
		});
		try {
			const err = await readAllProjectFiles(dir).catch((e) => e);
			expect(err.message).toContain('assets/images/grown.png');
			expect(errorToExitCode(err)).toBe(ExitCode.INVALID_USAGE);
		} finally {
			lstatSpy.mockReset();
			lstatSpy.mockImplementation(actual.lstat as never);
		}
	});
});
