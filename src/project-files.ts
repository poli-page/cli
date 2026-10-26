import type { ProjectFileEntry } from './api-client.js';
import { MANIFEST_FILENAME } from './constants.js';

/**
 * The project file set, shared by the draft sync (`poli watch`, `poli dev`)
 * and `poli publish`. It mirrors the API's classifier: a path outside it is
 * refused with `400 UNSUPPORTED_FILE_TYPE`, which fails the whole request, so
 * the CLI leaves such files out instead of sending them.
 *
 * Accepted: `poli-page.json` and `tailwind.css` at the root; `.html`,
 * `.json` and `.css` files at any depth under `templates/{slug}/`; `.html`
 * files at any depth under `partials/`; any file under `assets/images/` or
 * `assets/icons/`; `.woff2`, `.woff`, `.ttf` and `.otf` files under
 * `assets/fonts/`. Paths are POSIX, relative to the project root.
 */
const TEMPLATE_SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const TEMPLATE_FILE_EXTENSIONS = new Set(['html', 'json', 'css']);
const FONT_EXTENSIONS = new Set(['woff2', 'woff', 'ttf', 'otf']);

function extensionOf(fileName: string): string {
	const dot = fileName.lastIndexOf('.');
	return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

export function isAcceptedProjectPath(path: string): boolean {
	if (path === MANIFEST_FILENAME || path === 'tailwind.css') return true;

	const segments = path.split('/');
	const [root, folder] = segments;
	const extension = extensionOf(segments[segments.length - 1]);

	// A slug holds no dot and an accepted extension needs one, so a file
	// directly under `templates/` never passes.
	if (root === 'templates') {
		return TEMPLATE_SLUG_RE.test(folder) && TEMPLATE_FILE_EXTENSIONS.has(extension);
	}
	if (root === 'partials') return extension === 'html';
	if (root === 'assets' && segments.length >= 3) {
		if (folder === 'images' || folder === 'icons') return true;
		return folder === 'fonts' && FONT_EXTENSIONS.has(extension);
	}
	return false;
}

/**
 * Everything under `assets/` (images, icons, fonts) is binary and travels as
 * base64; the rest of the accepted set is text and travels as utf8.
 */
export function projectFileEncoding(path: string): ProjectFileEntry['encoding'] {
	return path.startsWith('assets/') ? 'base64' : 'utf8';
}

export function toProjectFileEntry(path: string, content: string): ProjectFileEntry {
	return { path, encoding: projectFileEncoding(path), content };
}

/** `readAllProjectFiles` output → wire entries, sorted by path. */
export function toProjectFileEntries(files: Map<string, string>): ProjectFileEntry[] {
	return [...files]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([path, content]) => toProjectFileEntry(path, content));
}
