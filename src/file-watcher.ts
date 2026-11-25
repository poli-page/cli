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
// stats are in. A directory holding an extra path stays walked so chokidar
// reaches that path; its other entries still go through the checks.
// Paths are compared project-relative in POSIX form: chokidar hands
// `ignored` forward-slash paths, `resolve()` gives backslashes on Windows.
export function projectIgnoredFn(
	cwd: string,
	extraPaths: ReadonlySet<string>
): (path: string, stats?: Stats) => boolean {
	const toPosixRelative = (path: string) => relative(cwd, path).split(/[\\/]/).join('/');
	const extras = [...extraPaths].map(toPosixRelative);
	return (path, stats) => {
		const relPath = toPosixRelative(path);
		if (extras.includes(relPath)) return false;
		if (!stats || stats.isDirectory()) {
			if (extras.some((extra) => extra.startsWith(relPath + '/'))) return false;
			return isInIgnoredProjectDirectory(relPath);
		}
		return shouldIgnoreProjectPath(relPath);
	};
}

export interface FileWatcherOptions {
	cwd: string;
	debounceMs?: number;
	/** Absolute paths under `cwd` that trigger a batch outside the file set. */
	extraPaths?: string[];
	onBatch: (paths: Set<string>) => void;
}

export interface FileWatcher {
	close(): Promise<void>;
}

export function createFileWatcher(options: FileWatcherOptions): FileWatcher {
	const debounceMs = options.debounceMs ?? 2000;

	const batcher = createDebouncedBatcher<string>(debounceMs, options.onBatch);

	const watcher = chokidar.watch(options.cwd, {
		ignored: projectIgnoredFn(options.cwd, new Set(options.extraPaths)),
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
