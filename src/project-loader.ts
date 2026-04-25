import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { readManifest, type PoliPageManifest } from './manifest.js';
import { MANIFEST_FILENAME } from './constants.js';

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
	let manifest;
	try {
		manifest = await readManifest(cwd);
	} catch {
		throw new Error(`No ${MANIFEST_FILENAME} found in ${cwd}. Are you in a Poli Page project?`);
	}
	return { manifest, projectDir: cwd };
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
	const templateDir = join(projectDir, 'templates', entry.name);
	const htmlPath = join(templateDir, entry.template);
	const mockPath = join(templateDir, entry.mock);

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

	// Mock files can use { locale, data: {...} } structure or flat data
	const hasDataField =
		'data' in mockJson && typeof mockJson.data === 'object' && mockJson.data !== null;
	const data = hasDataField
		? (mockJson.data as Record<string, unknown>)
		: mockJson;
	const locale = typeof mockJson.locale === 'string' ? mockJson.locale : undefined;

	return { entry, html, data, locale };
}

export function createAssetsResolver(projectDir: string) {
	return (path: string): Buffer => {
		const { readFileSync } = require('node:fs');
		const fullPath = join(projectDir, 'assets', path);
		return readFileSync(fullPath);
	};
}

export function createFontsResolver(projectDir: string) {
	return (path: string): Buffer => {
		const { readFileSync } = require('node:fs');
		const fullPath = join(projectDir, 'assets', path);
		return readFileSync(fullPath);
	};
}

export async function loadTailwindCss(projectDir: string): Promise<string | undefined> {
	try {
		return await readFile(join(projectDir, 'tailwind.css'), 'utf-8');
	} catch {
		return undefined;
	}
}

export async function collectProjectPayload(
	projectDir: string,
	manifest: PoliPageManifest,
): Promise<Record<string, unknown>> {
	// Collect template files
	const templateFiles: Array<{ path: string; content: string }> = [];
	for (const tpl of manifest.templates ?? []) {
		const templateDir = join(projectDir, 'templates', tpl.name);
		const htmlPath = join(templateDir, tpl.template);
		const htmlContent = await readFile(htmlPath, 'utf-8');
		templateFiles.push({ path: tpl.template, content: htmlContent });

		if (tpl.mock) {
			const mockPath = join(templateDir, tpl.mock);
			const mockContent = await readFile(mockPath, 'utf-8');
			templateFiles.push({ path: tpl.mock, content: mockContent });
		}
	}

	// Collect assets (images + fonts)
	const imageFiles: Array<{ path: string; data: string }> = [];
	const assetsDir = join(projectDir, 'assets');
	try {
		const assetEntries = await readdir(assetsDir, { recursive: true });
		for (const entry of assetEntries) {
			const fullPath = join(assetsDir, entry);
			const s = await stat(fullPath);
			if (s.isFile() && /\.(png|jpg|jpeg|gif|svg|webp|woff2|woff|ttf|otf)$/i.test(entry)) {
				const buffer = await readFile(fullPath);
				imageFiles.push({ path: entry, data: buffer.toString('base64') });
			}
		}
	} catch {
		// No assets directory
	}

	const tailwindCss = await loadTailwindCss(projectDir);

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
