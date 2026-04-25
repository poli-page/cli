import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../src/commands/init.js';
import { executeNew } from '../src/commands/new.js';
import { loadProject, findTemplate, loadTemplate, loadTailwindCss } from '../src/project-loader.js';

describe('project-loader', () => {
	let tempDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-loader-'));
		projectDir = await executeInit('test-project', { cwd: tempDir });
		await executeNew('invoice', { cwd: projectDir });
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
	});

	describe('loadTailwindCss', () => {
		it('should load tailwind.css if present', async () => {
			const css = await loadTailwindCss(projectDir);
			expect(css).toContain('@theme');
		});

		it('should return undefined if no tailwind.css', async () => {
			const emptyDir = await mkdtemp(join(tmpdir(), 'poli-no-tw-'));
			const css = await loadTailwindCss(emptyDir);
			expect(css).toBeUndefined();
			await rm(emptyDir, { recursive: true, force: true });
		});
	});
});
