import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readProjectManifest, type PoliPageManifest } from './manifest.js';
import { MANIFEST_FILENAME } from './constants.js';
import { resolveInside } from './security/paths.js';
import { readAllProjectFiles } from './project-sync.js';
import { toProjectFileEntries } from './project-files.js';

export interface TemplateEntry {
	name: string;
	template: string;
	mock: string;
	format: string;
	orientation: string;
}

export interface LoadedTemplate {
	entry: TemplateEntry;
	html: string;
	data: Record<string, unknown>;
	locale?: string;
}

export interface LoadedProject {
	manifest: PoliPageManifest;
	projectDir: string;
}

export async function loadProject(cwd: string): Promise<LoadedProject> {
	return { manifest: await readProjectManifest(cwd), projectDir: cwd };
}

export function findTemplate(
	manifest: PoliPageManifest,
	name: string
): TemplateEntry {
	const entry = manifest.templates?.find((t) => t.name === name);
	if (!entry) {
		const available = manifest.templates?.map((t) => t.name).join(', ') || 'none';
		throw new Error(
			`Template "${name}" not found in ${MANIFEST_FILENAME}. Available: ${available}`
		);
	}
	return {
		name: entry.name,
		template: entry.template,
		mock: entry.mock,
		format: entry.format ?? 'A4',
		orientation: entry.orientation ?? 'portrait',
	};
}

export async function loadTemplate(
	projectDir: string,
	entry: TemplateEntry
): Promise<LoadedTemplate> {
	// Against the project root, so a symlinked `templates/<name>` folder is
	// refused too: the mock is sent to the API as render data.
	const templateDir = join('templates', entry.name);
	const htmlPath = await resolveInside(projectDir, join(templateDir, entry.template));
	const mockPath = await resolveInside(projectDir, join(templateDir, entry.mock));

	let html: string;
	try {
		html = await readFile(htmlPath, 'utf-8');
	} catch {
		throw new Error(`Template file not found: ${htmlPath}`);
	}

	let mockJson: Record<string, unknown>;
	try {
		const mockContent = await readFile(mockPath, 'utf-8');
		mockJson = JSON.parse(mockContent);
	} catch {
		throw new Error(`Mock data file not found or invalid: ${mockPath}`);
	}

	const { data, locale } = unwrapMockJson(mockJson);
	return { entry, html, data, locale };
}

/**
 * Mock and `--data` JSON files can be written in two shapes:
 *
 *   1. Wrapped (matches what the API expects + what `poli init` scaffolds):
 *      `{ "locale": "fr", "data": { "title": "..." } }`
 *
 *   2. Flat:
 *      `{ "title": "..." }`
 *
 * This helper detects the wrapped shape and returns `{ data, locale }` so
 * callers don't have to reimplement the dewrap (and risk double-wrapping
 * the payload on the way to the API). Used by `loadTemplate` for the
 * on-disk mock and by `executeRender` for `--data` overrides.
 */
export function unwrapMockJson(
	json: Record<string, unknown>
): { data: Record<string, unknown>; locale: string | undefined } {
	const hasDataField =
		'data' in json && typeof json.data === 'object' && json.data !== null;
	const data = hasDataField
		? (json.data as Record<string, unknown>)
		: json;
	const locale = typeof json.locale === 'string' ? json.locale : undefined;
	return { data, locale };
}

/**
 * The bundle `poli link` sends to create the cloud project, built from the
 * project file set (`readAllProjectFiles`, as for `poli publish`): it holds
 * regular files inside the project only, never a symlink, so a cloned
 * folder cannot make the link upload a file from outside it.
 */
export async function collectProjectPayload(
	projectDir: string,
	manifest: PoliPageManifest,
): Promise<Record<string, unknown>> {
	const files = await readAllProjectFiles(projectDir);

	// The API takes template files by their name inside `templates/<name>/`.
	// One the manifest names but the file set lacks fails the link: the cloud
	// project would be created without it.
	const templateFiles: Array<{ path: string; content: string }> = [];
	for (const tpl of manifest.templates ?? []) {
		for (const fileName of [tpl.template, tpl.mock]) {
			const key = `templates/${tpl.name}/${fileName}`;
			const content = files.get(key);
			if (content === undefined) {
				throw new Error(
					`${key} is not a file of the project (missing, symlinked, or not .html, .json or .css).`
				);
			}
			templateFiles.push({ path: fileName, content });
		}
	}

	// Assets go by their path under `assets/`, already base64. In the file
	// set only assets carry these extensions.
	const imageFiles = toProjectFileEntries(files)
		.filter((file) => /\.(png|jpg|jpeg|gif|svg|webp|woff2|woff|ttf|otf)$/i.test(file.path))
		.map((file) => ({ path: file.path.slice('assets/'.length), data: file.content }));

	const tailwindCss = files.get('tailwind.css');

	return {
		manifest: {
			project: manifest.project,
			fonts: (manifest.fonts ?? []).map((f) => ({
				...f,
				weight: f.weight ?? 400,
				style: f.style ?? 'normal',
			})),
			templates: manifest.templates ?? [],
		},
		templates: templateFiles,
		...(imageFiles.length > 0 && { images: imageFiles }),
		...(tailwindCss && { tailwindCss }),
	};
}
