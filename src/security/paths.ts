import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// One path segment: no `.` or `..`, no separators, no `?`/`#`/`%` that would
// let a fetch URL and a disk path disagree, no `:` drive prefix.
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeSegment(segment: unknown): segment is string {
	return typeof segment === 'string' && SAFE_SEGMENT_RE.test(segment);
}

/**
 * Throw unless `p` is a relative POSIX path made only of safe segments.
 * `what` names the field in the error (e.g. `fonts[].src`).
 */
export function assertSafeRelativePath(p: unknown, what = 'path'): asserts p is string {
	if (typeof p !== 'string' || !p.split('/').every(isSafeSegment)) {
		throw new Error(
			`Unsafe ${what} ${JSON.stringify(p)}: expected a relative path of letters, digits, ".", "_" and "-" segments.`
		);
	}
}

/**
 * Resolve `rel` under `root` and return the absolute path, or throw when it
 * lands outside `root` — lexically, or through a symlinked ancestor (or the
 * target itself being a symlink). Neither `root` nor the target need exist.
 */
export async function resolveInside(root: string, rel: string): Promise<string> {
	const absRoot = resolve(root);
	const target = resolve(absRoot, rel);
	const realRoot = await realpathOfDeepestExisting(absRoot);
	const realTarget = await realpathOfDeepestExisting(target);
	if (
		!isWithin(absRoot, target) ||
		realRoot === null ||
		realTarget === null ||
		!isWithin(realRoot, realTarget)
	) {
		throw new Error(`Refusing path "${rel}": it resolves outside ${absRoot}.`);
	}
	return target;
}

function isWithin(root: string, p: string): boolean {
	const rel = relative(root, p);
	return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

// realpath of the deepest ancestor that exists, with the missing tail
// re-appended; null when a dangling symlink sits on the way, since a write
// would follow it to wherever it points.
async function realpathOfDeepestExisting(p: string): Promise<string | null> {
	const missing: string[] = [];
	let current = p;
	for (;;) {
		try {
			return join(await realpath(current), ...missing.reverse());
		} catch (err) {
			const parent = dirname(current);
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) throw err;
			const link = await lstat(current).then(
				(s) => s.isSymbolicLink(),
				() => false
			);
			if (link) return null;
			missing.push(basename(current));
			current = parent;
		}
	}
}
