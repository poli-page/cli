import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	assertSafeRelativePath,
	isSafeDottedSegment,
	isSafeSegment,
	resolveInside,
} from '../src/security/paths.js';

describe('isSafeSegment', () => {
	it('accepts one plain segment', () => {
		expect(isSafeSegment('invoice')).toBe(true);
		expect(isSafeSegment('header-main_footer.v2')).toBe(true);
	});

	it('refuses separators, dot segments and non-strings', () => {
		for (const bad of ['a/b', '.', '..', '.hidden', '', 'a\\b', 'C:', 'a?b', 42, undefined]) {
			expect(isSafeSegment(bad), String(bad)).toBe(false);
		}
	});
});

describe('isSafeDottedSegment', () => {
	it('accepts a plain segment and a dotfile', () => {
		for (const ok of ['invoice', '.gitignore', '.poli-page', '.github', '_x', 'a..b']) {
			expect(isSafeDottedSegment(ok), ok).toBe(true);
		}
	});

	it('refuses separators, dot-only segments and non-strings', () => {
		for (const bad of [
			'a/b',
			'.',
			'..',
			'...',
			'',
			'a\\b',
			'C:',
			'a?b',
			'a#b',
			'%2e',
			42,
			undefined,
		]) {
			expect(isSafeDottedSegment(bad), String(bad)).toBe(false);
		}
	});
});

describe('assertSafeRelativePath', () => {
	it('accepts relative POSIX paths of safe segments', () => {
		expect(() => assertSafeRelativePath('logo.png')).not.toThrow();
		expect(() => assertSafeRelativePath('fonts/dm-sans-latin.woff2')).not.toThrow();
	});

	it.each([
		['traversal', '../x'],
		['inner traversal', 'fonts/../../x'],
		['query that keeps the URL in the repo', 'x?/../../.bashrc'],
		['fragment', 'a#b'],
		['percent-encoded traversal', '%2e%2e/x'],
		['backslash', 'a\\..\\b'],
		['absolute', '/etc/passwd'],
		['drive prefix', 'C:/x'],
		['empty segment', 'a//b'],
		['trailing slash', 'fonts/'],
		['empty', ''],
		['dot segment', './a'],
	])('refuses %s (%s)', (_label, p) => {
		expect(() => assertSafeRelativePath(p, 'fonts[].src')).toThrow(/Unsafe fonts\[\]\.src/);
	});

	it('refuses a non-string', () => {
		expect(() => assertSafeRelativePath(undefined, 'template.mock')).toThrow(/template\.mock/);
		expect(() => assertSafeRelativePath({}, 'images[]')).toThrow(/images\[\]/);
	});
});

describe('resolveInside', () => {
	let base: string;
	let root: string;
	let outside: string;

	beforeEach(async () => {
		base = await realpath(await mkdtemp(join(tmpdir(), 'poli-paths-')));
		root = join(base, 'root');
		outside = join(base, 'outside');
		await mkdir(root);
		await mkdir(outside);
	});

	afterEach(async () => {
		await rm(base, { recursive: true, force: true });
	});

	it('returns the absolute path of a target inside the root, existing or not', async () => {
		expect(await resolveInside(root, 'a/b.txt')).toBe(join(root, 'a', 'b.txt'));
		await writeFile(join(root, 'c.txt'), 'x');
		expect(await resolveInside(root, 'c.txt')).toBe(join(root, 'c.txt'));
	});

	it('accepts a root that does not exist yet', async () => {
		const missing = join(root, 'not', 'yet');
		expect(await resolveInside(missing, 'x/y')).toBe(join(missing, 'x', 'y'));
	});

	it('accepts a root reached through a symlink', async () => {
		const link = join(base, 'root-link');
		await symlink(root, link);
		expect(await resolveInside(link, 'a.txt')).toBe(join(link, 'a.txt'));
	});

	it('refuses lexical traversal and absolute paths', async () => {
		await expect(resolveInside(root, '../outside/x')).rejects.toThrow(/outside/);
		await expect(resolveInside(root, 'a/../../x')).rejects.toThrow(/outside/);
		await expect(resolveInside(root, join(outside, 'x'))).rejects.toThrow(/outside/);
	});

	it('refuses a target under a symlinked ancestor that leaves the root', async () => {
		await symlink(outside, join(root, 'assets'));
		await expect(resolveInside(root, 'assets/images/logo.png')).rejects.toThrow(/outside/);
	});

	it('refuses a target that is itself a symlink out of the root', async () => {
		await writeFile(join(outside, 'secret'), 'x');
		await symlink(join(outside, 'secret'), join(root, 'logo.png'));
		await expect(resolveInside(root, 'logo.png')).rejects.toThrow(/outside/);
	});

	it('refuses a dangling symlink, which a write would follow', async () => {
		await symlink(join(outside, 'not-yet'), join(root, 'logo.png'));
		await expect(resolveInside(root, 'logo.png')).rejects.toThrow(/outside/);
		await symlink(join(outside, 'no-dir'), join(root, 'fonts'));
		await expect(resolveInside(root, 'fonts/a.woff2')).rejects.toThrow(/outside/);
	});

	it('accepts a symlink that stays inside the root', async () => {
		await mkdir(join(root, 'real'));
		await symlink(join(root, 'real'), join(root, 'alias'));
		expect(await resolveInside(root, 'alias/x')).toBe(join(root, 'alias', 'x'));
	});
});
