import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { stubHome } from './fake-home.js';

const TESTS_DIR = join(import.meta.dirname, '..');

async function testFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) return testFiles(path);
			return entry.name.endsWith('.ts') ? [path] : [];
		})
	);
	return nested.flat();
}

describe('stubHome', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('points both HOME and USERPROFILE at the fake home', () => {
		stubHome('/tmp/poli-fake-home');

		expect(process.env.HOME).toBe('/tmp/poli-fake-home');
		expect(process.env.USERPROFILE).toBe('/tmp/poli-fake-home');
		expect(homedir()).toBe('/tmp/poli-fake-home');
	});

	// On Windows os.homedir() reads USERPROFILE: a file that stubs HOME
	// alone would read the developer's real stored session there.
	it('is the only place a test stubs the home directory', async () => {
		const offenders: string[] = [];
		for (const file of await testFiles(TESTS_DIR)) {
			if (file === join(import.meta.dirname, 'fake-home.ts')) continue;
			const source = await readFile(file, 'utf8');
			if (/stubEnv\(\s*['"](HOME|USERPROFILE)['"]/.test(source)) {
				offenders.push(relative(TESTS_DIR, file));
			}
		}

		expect(offenders).toEqual([]);
	});
});
