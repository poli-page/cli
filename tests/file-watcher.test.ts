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

// Resolves once chokidar has finished its initial scan, so the test reads
// the watched set (and starts writing) on chokidar's own signal, not a delay
// (#31).
async function startWatcher(
	options: FileWatcherOptions
): Promise<{ watcher: FileWatcher; watchedPaths: () => string[] }> {
	const watchSpy = vi.spyOn(chokidar, 'watch');
	const watcher = createFileWatcher(options);
	const fsWatcher = watchSpy.mock.results[0].value as FSWatcher;
	watchSpy.mockRestore();
	await new Promise((resolve) => fsWatcher.once('ready', resolve));
	return {
		watcher,
		watchedPaths: () =>
			Object.entries(fsWatcher.getWatched()).flatMap(([dir, names]) =>
				names.map((name) => join(dir, name))
			),
	};
}

// Resolves with the first batch that holds `path`, collecting every batch.
function batchWith(path: string): {
	batches: Array<Set<string>>;
	seen: Promise<void>;
	onBatch: (paths: Set<string>) => void;
} {
	const batches: Array<Set<string>> = [];
	let resolveSeen: () => void = () => {};
	const seen = new Promise<void>((resolve) => {
		resolveSeen = resolve;
	});
	return {
		batches,
		seen,
		onBatch: (paths) => {
			batches.push(paths);
			if (paths.has(path)) resolveSeen();
		},
	};
}

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

		const { batches, seen, onBatch } = batchWith('templates/invoice/invoice.html');
		const { watcher } = await startWatcher({ cwd: tempDir, debounceMs: 200, onBatch });

		await writeFile(join(tempDir, 'templates', 'invoice', 'invoice.html'), '<h1>v2</h1>');
		await seen;
		await watcher.close();

		expect(batches.flatMap((batch) => [...batch])).toContain('templates/invoice/invoice.html');
	});

	it('does not walk node_modules, .git, or output directories', async () => {
		for (const dir of ['node_modules', '.git', 'output']) {
			await mkdir(join(tempDir, 'templates', 'invoice', dir), { recursive: true });
			await writeFile(join(tempDir, 'templates', 'invoice', dir, 'page.html'), 'x');
		}

		const { watcher, watchedPaths } = await startWatcher({
			cwd: tempDir,
			debounceMs: 200,
			onBatch: () => {},
		});
		const watched = watchedPaths();
		await watcher.close();

		expect(watched).toContain(join(tempDir, 'templates', 'invoice'));
		for (const dir of ['node_modules', '.git', 'output']) {
			expect(watched).not.toContain(join(tempDir, 'templates', 'invoice', dir));
		}
	});

	it('emits a batch for an extra path outside the file set', async () => {
		await mkdir(join(tempDir, 'fixtures'), { recursive: true });
		await writeFile(join(tempDir, 'fixtures', 'acme.json'), '{}');
		await writeFile(join(tempDir, 'fixtures', 'other.json'), '{}');

		const { batches, seen, onBatch } = batchWith(join('fixtures', 'acme.json'));
		const { watcher } = await startWatcher({
			cwd: tempDir,
			debounceMs: 200,
			extraPaths: [join(tempDir, 'fixtures', 'acme.json')],
			onBatch,
		});

		await writeFile(join(tempDir, 'fixtures', 'other.json'), '{"a":1}');
		await writeFile(join(tempDir, 'fixtures', 'acme.json'), '{"a":1}');
		await seen;
		await watcher.close();

		expect(batches.flatMap((batch) => [...batch])).toEqual([join('fixtures', 'acme.json')]);
	});

	it.each(['dist', '.poli'])('emits a batch for an extra path inside %s/', async (dir) => {
		await mkdir(join(tempDir, dir), { recursive: true });
		await writeFile(join(tempDir, dir, 'acme.json'), '{}');
		await writeFile(join(tempDir, dir, 'other.json'), '{}');

		const { batches, seen, onBatch } = batchWith(join(dir, 'acme.json'));
		const { watcher } = await startWatcher({
			cwd: tempDir,
			debounceMs: 200,
			extraPaths: [join(tempDir, dir, 'acme.json')],
			onBatch,
		});

		await writeFile(join(tempDir, dir, 'other.json'), '{"a":1}');
		await writeFile(join(tempDir, dir, 'acme.json'), '{"a":1}');
		await seen;
		await watcher.close();

		expect(batches.flatMap((batch) => [...batch])).toEqual([join(dir, 'acme.json')]);
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

		const {
			batches,
			seen: acceptedSeen,
			onBatch,
		} = batchWith('templates/invoice/invoice.html');
		const { watcher, watchedPaths } = await startWatcher({
			cwd: tempDir,
			debounceMs: 200,
			onBatch,
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
		for (const dir of [
			'dist',
			'.poli',
			'node_modules',
			join('templates', 'invoice', '.poli'),
		]) {
			expect(watched).not.toContain(join(tempDir, dir));
		}
	});
});
