import chokidar from 'chokidar';
import { relative } from 'node:path';

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

// Chokidar v5 dropped glob support — `ignored` accepts functions, regexes,
// or literal path strings only. We test against the path with simple
// substring/suffix checks since chokidar passes absolute paths.
function defaultIgnoredFn(path: string): boolean {
	return (
		path.includes('/node_modules/') ||
		path.includes('/.git/') ||
		path.includes('/output/') ||
		path.endsWith('/.DS_Store') ||
		path.endsWith('.log')
	);
}

export interface FileWatcherOptions {
	cwd: string;
	debounceMs?: number;
	ignored?: (path: string) => boolean;
	onBatch: (paths: Set<string>) => void;
}

export interface FileWatcher {
	close(): Promise<void>;
}

export function createFileWatcher(options: FileWatcherOptions): FileWatcher {
	const debounceMs = options.debounceMs ?? 2000;
	const ignored = options.ignored ?? defaultIgnoredFn;

	const batcher = createDebouncedBatcher<string>(debounceMs, options.onBatch);

	const watcher = chokidar.watch(options.cwd, {
		ignored,
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
