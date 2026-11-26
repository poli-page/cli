import { describe, it, expect, vi } from 'vitest';

// Windows path rules on any CI runner: `extraPaths` comes from `resolve()`
// with backslashes, while chokidar hands `ignored` forward-slash paths.
vi.mock('node:path', async () => {
	const actual = await vi.importActual<typeof import('node:path')>('node:path');
	return { ...actual.win32, default: actual.win32 };
});

const { projectIgnoredFn } = await import('../src/file-watcher.js');

const cwd = 'C:\\proj';
const dir = { isDirectory: () => true } as import('node:fs').Stats;
const file = { isDirectory: () => false } as import('node:fs').Stats;

describe('projectIgnoredFn with Windows paths', () => {
	it('keeps an extra path chokidar reports with forward slashes', () => {
		const ignored = projectIgnoredFn(cwd, new Set(['C:\\proj\\data\\sample.json']));
		expect(ignored('C:/proj/data/sample.json', file)).toBe(false);
		expect(ignored('C:/proj/data/other.json', file)).toBe(true);
	});

	it('keeps walking an ignored directory that holds an extra path', () => {
		const ignored = projectIgnoredFn(cwd, new Set(['C:\\proj\\dist\\sample.json']));
		expect(ignored('C:/proj/dist', dir)).toBe(false);
		expect(ignored('C:/proj/.poli', dir)).toBe(true);
	});
});
