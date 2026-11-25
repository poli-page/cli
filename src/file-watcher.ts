import chokidar from 'chokidar';
import type { Stats } from 'node:fs';
import { relative } from 'node:path';
import { isInIgnoredProjectDirectory, shouldIgnoreProjectPath } from './project-sync.js';

export interface DebouncedBatcher<T> {
	push(item: T): void;
	flush(): void;
	close(): void;
}

export function createDebouncedBatcher<T>(
	debounceMs: number,
	onBatch: (items: Set<T>) => void
): DebouncedBatcher<T> {
	let pending = new Set<T>();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;

	function emit() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (pending.size === 0) return;
		const batch = pending;
		pending = new Set<T>();
		onBatch(batch);
	}

	return {
		push(item: T) {
			if (closed) return;
			pending.add(item);
			if (timer) clearTimeout(timer);
			timer = setTimeout(emit, debounceMs);
		},
		flush() {
			if (closed) return;
			emit();
		},
		close() {
			closed = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			pending = new Set<T>();
		},
	};
}

// Chokidar calls `ignored` with the stats when it has them and without
// them on some paths (before its own stat, on unlink), so a path without
// stats is treated as a directory: the file check runs again once the
// stats are in.
function projectIgnoredFn(cwd: string): (path: string, stats?: Stats) => boolean {
	return (path, stats) => {
		const relPath = relative(cwd, path);
		if (!stats || stats.isDirectory()) return isInIgnoredProjectDirectory(relPath);
		return shouldIgnoreProjectPath(relPath);
	};
}

export interface FileWatcherOptions {
	cwd: string;
	debounceMs?: number;
	onBatch: (paths: Set<string>) => void;
}

export interface FileWatcher {
	close(): Promise<void>;
}

export function createFileWatcher(options: FileWatcherOptions): FileWatcher {
	const debounceMs = options.debounceMs ?? 2000;

	const batcher = createDebouncedBatcher<string>(debounceMs, options.onBatch);

	const watcher = chokidar.watch(options.cwd, {
		ignored: projectIgnoredFn(options.cwd),
		// With lstat, a symlink is an entry of its own and never a directory
		// to walk: a link to `~` or `/` stays out of the watched tree.
		followSymlinks: false,
		ignoreInitial: true,
		persistent: true,
	});

	function relativeOf(absolutePath: string): string {
		return relative(options.cwd, absolutePath);
	}

	watcher.on('add', (path) => batcher.push(relativeOf(path)));
	watcher.on('change', (path) => batcher.push(relativeOf(path)));
	watcher.on('unlink', (path) => batcher.push(relativeOf(path)));

	return {
		async close() {
			batcher.close();
			await watcher.close();
		},
	};
}
