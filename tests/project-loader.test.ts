import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdir, mkdtemp, rm, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../src/commands/init.js';
import { setupTemplate } from './helpers/setup-template.js';
import {
	loadProject,
	findTemplate,
	loadTemplate,
	collectProjectPayload,
} from '../src/project-loader.js';

describe('project-loader', () => {
	let tempDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-loader-'));
		projectDir = await executeInit('test-project', { cwd: tempDir });
		await setupTemplate(projectDir, 'invoice');
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe('loadProject', () => {
		it('should load a valid project', async () => {
			const project = await loadProject(projectDir);
			expect(project.manifest.project.name).toBe('test-project');
			expect(project.projectDir).toBe(projectDir);
		});

		it('should throw if no manifest found', async () => {
			await expect(loadProject(tempDir + '/nonexistent')).rejects.toThrow(
				/poli-page\.json/
			);
		});
	});

	describe('loadProject validation', () => {
		it('reports the manifest field that fails validation instead of a missing manifest', async () => {
			const manifestPath = join(projectDir, 'poli-page.json');
			const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
			manifest.templates[0].mock = '../../../.polipage/credentials';
			await writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');

			await expect(loadProject(projectDir)).rejects.toThrow(/templates\[0\]\.mock/);
		});

		it('keeps the validation error when the refused value contains "ENOENT"', async () => {
			const manifestPath = join(projectDir, 'poli-page.json');
			const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
			manifest.templates[0].mock = 'ENOENT/../invoice.json';
			await writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');

			await expect(loadProject(projectDir)).rejects.toThrow(/templates\[0\]\.mock/);
		});
	});

	describe('findTemplate', () => {
		it('should find a template by name', async () => {
			const { manifest } = await loadProject(projectDir);
			const entry = findTemplate(manifest, 'invoice');
			expect(entry.name).toBe('invoice');
			expect(entry.template).toBe('invoice.html');
			expect(entry.mock).toBe('invoice.json');
			expect(entry.format).toBe('A4');
			expect(entry.orientation).toBe('portrait');
		});

		it('should throw if template not found', async () => {
			const { manifest } = await loadProject(projectDir);
			expect(() => findTemplate(manifest, 'nonexistent')).toThrow(
				/not found.*Available: invoice/
			);
		});
	});

	describe('loadTemplate', () => {
		it('should load HTML and extract data from mock JSON', async () => {
			const { manifest } = await loadProject(projectDir);
			const entry = findTemplate(manifest, 'invoice');
			const loaded = await loadTemplate(projectDir, entry);

			expect(loaded.html).toContain('poli-header');
			expect(loaded.data).toBeDefined();
			expect(loaded.data).toHaveProperty('title');
		});

		it('should extract locale from mock JSON', async () => {
			const { manifest } = await loadProject(projectDir);
			const entry = findTemplate(manifest, 'invoice');
			const loaded = await loadTemplate(projectDir, entry);

			expect(loaded.locale).toBe('en');
		});

		it.each(['template', 'mock'] as const)(
			'refuses a %s file symlinked outside the project',
			async (field) => {
				const outside = join(tempDir, 'secret.json');
				await writeFile(outside, '{"token":"s3cret"}', 'utf-8');
				const { manifest } = await loadProject(projectDir);
				const entry = findTemplate(manifest, 'invoice');
				const linked = join(projectDir, 'templates', 'invoice', entry[field]);
				await rm(linked);
				await symlink(outside, linked);

				await expect(loadTemplate(projectDir, entry)).rejects.toThrow(/resolves outside/);
			}
		);

		it('refuses a template folder symlinked outside the project', async () => {
			const outside = join(tempDir, 'elsewhere');
			await cp(join(projectDir, 'templates', 'invoice'), outside, { recursive: true });
			await rm(join(projectDir, 'templates', 'invoice'), { recursive: true });
			await symlink(outside, join(projectDir, 'templates', 'invoice'));
			const { manifest } = await loadProject(projectDir);

			await expect(loadTemplate(projectDir, findTemplate(manifest, 'invoice'))).rejects.toThrow(
				/resolves outside/
			);
		});
	});

	describe('collectProjectPayload', () => {
		async function addProjectFiles(): Promise<void> {
			await mkdir(join(projectDir, 'assets', 'images'), { recursive: true });
			await mkdir(join(projectDir, 'assets', 'fonts'), { recursive: true });
			await writeFile(join(projectDir, 'assets', 'images', 'logo.png'), Buffer.from([1, 2, 3]));
			await writeFile(join(projectDir, 'assets', 'fonts', 'inter-400.woff2'), Buffer.from([4, 5]));
			// In the file set, but never part of the link payload.
			await writeFile(join(projectDir, 'assets', 'images', 'notes.txt'), 'notes', 'utf-8');
		}

		it('builds a normal project\'s payload', async () => {
			await addProjectFiles();
			const { manifest } = await loadProject(projectDir);

			const payload = await collectProjectPayload(projectDir, manifest);

			expect(payload).toEqual({
				manifest: {
					project: manifest.project,
					fonts: [],
					templates: manifest.templates,
				},
				templates: [
					{ path: 'invoice.html', content: '<div class="poli-header"></div><div>{{ content }}</div>' },
					{
						path: 'invoice.json',
						content: JSON.stringify({ locale: 'en', data: { title: 'Sample', content: 'Hello' } }),
					},
				],
				images: [
					{ path: 'fonts/inter-400.woff2', data: Buffer.from([4, 5]).toString('base64') },
					{ path: 'images/logo.png', data: Buffer.from([1, 2, 3]).toString('base64') },
				],
				tailwindCss: await readFile(join(projectDir, 'tailwind.css'), 'utf-8'),
			});
		});

		it('leaves out an asset symlinked outside the project', async () => {
			await addProjectFiles();
			const outside = join(tempDir, 'id_ed25519.png');
			await writeFile(outside, 'PRIVATE KEY', 'utf-8');
			await symlink(outside, join(projectDir, 'assets', 'images', 'key.png'));
			const { manifest } = await loadProject(projectDir);

			const payload = await collectProjectPayload(projectDir, manifest);

			expect((payload.images as Array<{ path: string }>).map((i) => i.path)).toEqual([
				'fonts/inter-400.woff2',
				'images/logo.png',
			]);
		});

		it('leaves out an assets folder symlinked outside the project', async () => {
			const outside = join(tempDir, 'ssh');
			await mkdir(outside);
			await writeFile(join(outside, 'id_ed25519.png'), 'PRIVATE KEY', 'utf-8');
			await rm(join(projectDir, 'assets', 'images'), { recursive: true, force: true });
			await mkdir(join(projectDir, 'assets'), { recursive: true });
			await symlink(outside, join(projectDir, 'assets', 'images'));
			const { manifest } = await loadProject(projectDir);

			const payload = await collectProjectPayload(projectDir, manifest);

			expect(payload).not.toHaveProperty('images');
		});

		it('leaves out a tailwind.css symlinked outside the project', async () => {
			const outside = join(tempDir, 'credentials');
			await writeFile(outside, '{"session":"s3cret"}', 'utf-8');
			await rm(join(projectDir, 'tailwind.css'));
			await symlink(outside, join(projectDir, 'tailwind.css'));
			const { manifest } = await loadProject(projectDir);

			const payload = await collectProjectPayload(projectDir, manifest);

			expect(payload).not.toHaveProperty('tailwindCss');
		});

		it('leaves out an asset outside assets/images, assets/icons and assets/fonts', async () => {
			await addProjectFiles();
			await mkdir(join(projectDir, 'assets', 'brand'), { recursive: true });
			await writeFile(join(projectDir, 'assets', 'logo.png'), Buffer.from([7]));
			await writeFile(join(projectDir, 'assets', 'brand', 'mark.svg'), '<svg/>', 'utf-8');
			await writeFile(join(projectDir, 'assets', 'fonts', 'glyph.svg'), '<svg/>', 'utf-8');
			const { manifest } = await loadProject(projectDir);

			const payload = await collectProjectPayload(projectDir, manifest);

			expect((payload.images as Array<{ path: string }>).map((i) => i.path)).toEqual([
				'fonts/inter-400.woff2',
				'images/logo.png',
			]);
		});

		it('refuses a template path that leaves its template folder', async () => {
			await mkdir(join(projectDir, 'templates', 'other'), { recursive: true });
			await writeFile(join(projectDir, 'templates', 'other', 'secret.html'), 's3cret', 'utf-8');
			const { manifest } = await loadProject(projectDir);
			// The schema refuses `..`; the payload must not depend on it.
			manifest.templates![0].template = '../other/secret.html';

			const error = await collectProjectPayload(projectDir, manifest).catch((e: Error) => e);

			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(
				'templates/invoice/../other/secret.html is not a file of the project'
			);
			expect((error as Error).message).not.toContain('s3cret');
		});

		it.each(['template', 'mock'] as const)(
			'refuses a %s file symlinked outside the project, without reading it',
			async (field) => {
				const outside = join(tempDir, 'secret.json');
				await writeFile(outside, '{"token":"s3cret"}', 'utf-8');
				const { manifest } = await loadProject(projectDir);
				const fileName = findTemplate(manifest, 'invoice')[field];
				const linked = join(projectDir, 'templates', 'invoice', fileName);
				await rm(linked);
				await symlink(outside, linked);

				const error = await collectProjectPayload(projectDir, manifest).catch((e: Error) => e);

				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain(`templates/invoice/${fileName} is not a file of the project`);
				expect((error as Error).message).not.toContain('s3cret');
			}
		);

		it.each(['template', 'mock'] as const)('refuses a missing %s file', async (field) => {
			const { manifest } = await loadProject(projectDir);
			const fileName = findTemplate(manifest, 'invoice')[field];
			await rm(join(projectDir, 'templates', 'invoice', fileName));

			await expect(collectProjectPayload(projectDir, manifest)).rejects.toThrow(
				`templates/invoice/${fileName} is not a file of the project`
			);
		});

		it('refuses a template folder symlinked outside the project', async () => {
			const outside = join(tempDir, 'elsewhere');
			await cp(join(projectDir, 'templates', 'invoice'), outside, { recursive: true });
			await rm(join(projectDir, 'templates', 'invoice'), { recursive: true });
			await symlink(outside, join(projectDir, 'templates', 'invoice'));
			const { manifest } = await loadProject(projectDir);

			await expect(collectProjectPayload(projectDir, manifest)).rejects.toThrow(
				'templates/invoice/invoice.html is not a file of the project'
			);
		});
	});
});
