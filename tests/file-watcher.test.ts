import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDebouncedBatcher, createFileWatcher } from '../src/file-watcher.js';

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
		await mkdir(join(tempDir, 'templates'), { recursive: true });
		await writeFile(join(tempDir, 'templates', 'invoice.html'), '<h1>v1</h1>');

		const batches: Array<Set<string>> = [];
		const watcher = createFileWatcher({
			cwd: tempDir,
			debounceMs: 200,
			onBatch: (paths) => batches.push(paths),
		});

		// Wait for chokidar to be ready
		await new Promise((r) => setTimeout(r, 300));

		await writeFile(join(tempDir, 'templates', 'invoice.html'), '<h1>v2</h1>');

		// Wait for the debounced batch
		await new Promise((r) => setTimeout(r, 600));
		await watcher.close();

		const allChanges = new Set<string>();
		for (const batch of batches) {
			for (const p of batch) {
				allChanges.add(p);
			}
		}
		expect(allChanges.has('templates/invoice.html')).toBe(true);
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
