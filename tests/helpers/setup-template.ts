import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readManifest, writeManifest } from '../../src/manifest.js';

/**
 * Adds a minimal template entry to a project for use in tests of commands
 * that don't care about the import flow itself (render, link, push, etc.).
 *
 * Replaces the previous pattern of calling `executeNew('invoice', { cwd })`
 * which now requires --from-template and a fetcher.
 */
export async function setupTemplate(
	projectDir: string,
	name: string,
	options: {
		html?: string;
		mock?: Record<string, unknown>;
		format?: string;
		orientation?: string;
	} = {}
): Promise<void> {
	const html = options.html ?? `<div class="poli-header"></div><div>{{ content }}</div>`;
	const mock =
		options.mock ?? {
			locale: 'en',
			data: { title: 'Sample', content: 'Hello' },
		};
	const format = options.format ?? 'A4';
	const orientation = options.orientation ?? 'portrait';

	const templateDir = join(projectDir, 'templates', name);
	await mkdir(templateDir, { recursive: true });
	await writeFile(join(templateDir, `${name}.html`), html, 'utf-8');
	await writeFile(join(templateDir, `${name}.json`), JSON.stringify(mock), 'utf-8');

	const manifest = await readManifest(projectDir);
	manifest.templates = manifest.templates ?? [];
	manifest.templates.push({
		name,
		template: `${name}.html`,
		mock: `${name}.json`,
		format,
		orientation,
	});
	await writeManifest(projectDir, manifest);
}
