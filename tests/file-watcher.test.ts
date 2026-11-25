import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import {
	createDebouncedBatcher,
	createFileWatcher,
	type FileWatcher,
	type FileWatcherOptions,
} from '../src/file-watcher.js';

describe('createDebouncedBatcher', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('emits a single batch after debounceMs of silence', () => {
		const onBatch = vi.fn();
		const batcher = createDebouncedBatcher<string>(2000, onBatch);

		batcher.push('templates/inv.html');
		batcher.push('templates/inv.json');

		expect(onBatch).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1999);
		expect(onBatch).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);

		expect(onBatch).toHaveBeenCalledTimes(1);
		const batch = onBatch.mock.calls[0][0] as Set<string>;
		expect([...batch].sort()).toEqual([
			'templates/inv.html',
			'templates/inv.json',
		]);
	});

	it('resets the debounce window on each push', () => {
		const onBatch = vi.fn();
		const batcher = createDebouncedBatcher<string>(2000, onBatch);

		batcher.push('a');
		vi.advanceTimersByTime(1500);
		batcher.push('b');
		vi.advanceTimersByTime(1500);
		expect(onBatch).not.toHaveBeenCalled();
		vi.advanceTimersByTime(500);

		expect(onBatch).toHaveBeenCalledTimes(1);
		const batch = onBatch.mock.calls[0][0] as Set<string>;
		expect([...batch].sort()).toEqual(['a', 'b']);
	});

	it('emits separate batches when pushes are spaced beyond debounce', () => {
		const onBatch = vi.fn();
		const batcher = createDebouncedBatcher<string>(1000, onBatch);

		batcher.push('first');
		vi.advanceTimersByTime(1000);
		batcher.push('second');
		vi.advanceTimersByTime(1000);

		expect(onBatch).toHaveBeenCalledTimes(2);
		expect([...(onBatch.mock.calls[0][0] as Set<string>)]).toEqual(['first']);
		expect([...(onBatch.mock.calls[1][0] as Set<string>)]).toEqual(['second']);
	});

	it('flush() emits the pending batch immediately', () => {
		const onBatch = vi.fn();
		const batcher = createDebouncedBatcher<string>(2000, onBatch);

		batcher.push('a');
		batcher.flush();

		expect(onBatch).toHaveBeenCalledTimes(1);
		expect([...(onBatch.mock.calls[0][0] as Set<string>)]).toEqual(['a']);
	});

	it('flush() is a no-op when there is no pending batch', () => {
		const onBatch = vi.fn();
		const batcher = createDebouncedBatcher<string>(2000, onBatch);

		batcher.flush();
		expect(onBatch).not.toHaveBeenCalled();
	});

	it('close() prevents further batches', () => {
		const onBatch = vi.fn();
		const batcher = createDebouncedBatcher<string>(1000, onBatch);

		batcher.push('a');
		batcher.close();
		vi.advanceTimersByTime(2000);

		expect(onBatch).not.toHaveBeenCalled();
	});
});

describe('createFileWatcher (integration)', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-watcher-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('emits a batch with relative paths when files change', async () => {
		await mkdir(join(tempDir, 'templates', 'invoice'), { recursive: true });
		await writeFile(join(tempDir, 'templates', 'invoice', 'invoice.html'), '<h1>v1</h1>');

		const batches: Array<Set<string>> = [];
		const watcher = createFileWatcher({
			cwd: tempDir,
			debounceMs: 200,
			onBatch: (paths) => batches.push(paths),
		});

		// Wait for chokidar to be ready
		await new Promise((r) => setTimeout(r, 300));

		await writeFile(join(tempDir, 'templates', 'invoice', 'invoice.html'), '<h1>v2</h1>');

		// Wait for the debounced batch
		await new Promise((r) => setTimeout(r, 600));
		await watcher.close();

		const allChanges = new Set<string>();
		for (const batch of batches) {
			for (const p of batch) {
				allChanges.add(p);
			}
		}
		expect(allChanges.has('templates/invoice/invoice.html')).toBe(true);
	});

	it('ignores node_modules, .git, and output directories by default', async () => {
		await mkdir(join(tempDir, 'node_modules'), { recursive: true });
		await mkdir(join(tempDir, '.git'), { recursive: true });
		await mkdir(join(tempDir, 'output'), { recursive: true });
		await writeFile(join(tempDir, 'a.txt'), 'init');

		const batches: Array<Set<string>> = [];
		const watcher = createFileWatcher({
			cwd: tempDir,
			debounceMs: 200,
			onBatch: (paths) => batches.push(paths),
		});

		await new Promise((r) => setTimeout(r, 300));
		await writeFile(join(tempDir, 'node_modules', 'a.js'), 'x');
		await writeFile(join(tempDir, '.git', 'HEAD'), 'x');
		await writeFile(join(tempDir, 'output', 'page.pdf'), 'x');

		await new Promise((r) => setTimeout(r, 600));
		await watcher.close();

		const allChanges = new Set<string>();
		for (const batch of batches) {
			for (const p of batch) {
				allChanges.add(p);
			}
		}
		expect([...allChanges].some((p) => p.startsWith('node_modules'))).toBe(false);
		expect([...allChanges].some((p) => p.startsWith('.git'))).toBe(false);
		expect([...allChanges].some((p) => p.startsWith('output'))).toBe(false);
	});
});

describe('createFileWatcher (sync set)', () => {
	let tempDir: string;
	let outsideDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-watcher-'));
		outsideDir = await mkdtemp(join(tmpdir(), 'poli-watcher-outside-'));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(tempDir, { recursive: true, force: true });
		await rm(outsideDir, { recursive: true, force: true });
	});

	// Resolves once chokidar has finished its initial scan, so the test reads
	// the watched set (and starts writing) on chokidar's own signal, not a delay.
	async function startWatcher(
		options: FileWatcherOptions
	): Promise<{ watcher: FileWatcher; watchedPaths: () => string[] }> {
		const watchSpy = vi.spyOn(chokidar, 'watch');
		const watcher = createFileWatcher(options);
		const fsWatcher = watchSpy.mock.results[0].value as FSWatcher;
		await new Promise((resolve) => fsWatcher.once('ready', resolve));
		return {
			watcher,
			watchedPaths: () =>
				Object.entries(fsWatcher.getWatched()).flatMap(([dir, names]) =>
					names.map((name) => join(dir, name))
				),
		};
	}

	it('does not traverse a symlink to a large directory', async () => {
		for (let d = 0; d < 10; d++) {
			await mkdir(join(outsideDir, `dir-${d}`), { recursive: true });
			for (let f = 0; f < 10; f++) {
				await writeFile(join(outsideDir, `dir-${d}`, `outside-${f}.html`), 'x');
			}
		}
		await mkdir(join(tempDir, 'templates', 'invoice'), { recursive: true });
		await writeFile(join(tempDir, 'templates', 'invoice', 'invoice.html'), '<h1>v1</h1>');
		await symlink(outsideDir, join(tempDir, 'home'));
		await symlink(outsideDir, join(tempDir, 'templates', 'invoice', 'linked'));
		await symlink(outsideDir, join(tempDir, 'partials'));
		// Names inside the file set: only lstat keeps these from being walked.
		await mkdir(join(tempDir, 'assets', 'images'), { recursive: true });
		await symlink(outsideDir, join(tempDir, 'assets', 'images', 'linked'));
		await symlink(outsideDir, join(tempDir, 'templates', 'invoice', 'linked.html'));

		const { watcher, watchedPaths } = await startWatcher({
			cwd: tempDir,
			debounceMs: 200,
			onBatch: () => {},
		});
		const watched = watchedPaths();
		await watcher.close();

		expect(watched.filter((p) => p.includes('outside-')).length).toBe(0);
		expect(watched.filter((p) => p.includes('dir-')).length).toBe(0);
		expect(watched.length).toBeLessThan(10);
	});

	it('triggers no sync for dist/, .poli/ and paths outside the file set', async () => {
		await mkdir(join(tempDir, 'templates', 'invoice', '.poli'), { recursive: true });
		await mkdir(join(tempDir, 'dist'), { recursive: true });
		await mkdir(join(tempDir, '.poli'), { recursive: true });
		await mkdir(join(tempDir, 'node_modules'), { recursive: true });
		await writeFile(join(tempDir, 'templates', 'invoice', 'invoice.html'), '<h1>v1</h1>');

		const batches: Array<Set<string>> = [];
		let resolveAccepted: () => void = () => {};
		const acceptedSeen = new Promise<void>((resolve) => {
			resolveAccepted = resolve;
		});
		const { watcher, watchedPaths } = await startWatcher({
			cwd: tempDir,
			debounceMs: 200,
			onBatch: (paths) => {
				batches.push(paths);
				if (paths.has('templates/invoice/invoice.html')) resolveAccepted();
			},
		});
		const watched = watchedPaths();

		await writeFile(join(tempDir, 'dist', 'index.html'), 'x');
		await writeFile(join(tempDir, '.poli', 'state.json'), '{}');
		await writeFile(join(tempDir, 'templates', 'invoice', '.poli', 'cache.html'), 'x');
		await writeFile(join(tempDir, 'README.md'), 'x');
		await writeFile(join(tempDir, 'notes.txt'), 'x');
		await writeFile(join(tempDir, 'templates', 'invoice', 'notes.md'), 'x');
		// Written last: its batch shows the writes above were seen and dropped.
		await writeFile(join(tempDir, 'templates', 'invoice', 'invoice.html'), '<h1>v2</h1>');
		await acceptedSeen;
		await watcher.close();

		expect(batches.flatMap((batch) => [...batch])).toEqual(['templates/invoice/invoice.html']);
		for (const dir of ['dist', '.poli', 'node_modules', join('templates', 'invoice', '.poli')]) {
			expect(watched).not.toContain(join(tempDir, dir));
		}
	});
});
