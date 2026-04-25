import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeNew, getAvailableModels } from '../../src/commands/new.js';
import { executeInit } from '../../src/commands/init.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';

describe('poli new', () => {
	let tempDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-new-'));
		projectDir = await executeInit('test-project', { cwd: tempDir });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('should create an HTML template file in templates/', async () => {
		await executeNew('invoice', { cwd: projectDir });
		const htmlPath = join(projectDir, 'templates', 'invoice', 'invoice.html');
		const stats = await stat(htmlPath);
		expect(stats.isFile()).toBe(true);
	});

	it('should create a mock JSON file in templates/', async () => {
		await executeNew('invoice', { cwd: projectDir });
		const jsonPath = join(projectDir, 'templates', 'invoice', 'invoice.json');
		const content = await readFile(jsonPath, 'utf-8');
		const data = JSON.parse(content);
		expect(data).toBeDefined();
	});

	it('should add the template entry to poli-page.json', async () => {
		await executeNew('invoice', { cwd: projectDir });
		const manifest = JSON.parse(
			await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
		);

		expect(manifest.templates).toHaveLength(1);
		expect(manifest.templates[0]).toEqual({
			name: 'invoice',
			template: 'invoice.html',
			mock: 'invoice.json',
			format: 'A4',
			orientation: 'portrait',
		});
	});

	it('should use header-main-footer model by default', async () => {
		await executeNew('report', { cwd: projectDir });
		const htmlPath = join(projectDir, 'templates', 'report', 'report.html');
		const content = await readFile(htmlPath, 'utf-8');
		expect(content).toContain('poli-header');
		expect(content).toContain('poli-footer');
	});

	it('should copy content from the templates directory', async () => {
		await executeNew('report', { cwd: projectDir, model: 'header-main-footer' });
		const htmlPath = join(projectDir, 'templates', 'report', 'report.html');
		const content = await readFile(htmlPath, 'utf-8');
		// Must match the actual structure template, not a generated one
		expect(content).toContain('poli-header');
		expect(content).toContain('poli-footer');
		expect(content).toContain('poli-page-numbers');
		expect(content).toContain('formatDateTime');
	});

	it('should support the blank model', async () => {
		await executeNew('simple', { cwd: projectDir, model: 'blank' });
		const htmlPath = join(projectDir, 'templates', 'simple', 'simple.html');
		const content = await readFile(htmlPath, 'utf-8');
		expect(content).not.toContain('poli-header');
		expect(content).not.toContain('poli-footer');
	});

	it('should support sidebar models', async () => {
		await executeNew('doc', { cwd: projectDir, model: 'header-main-footer-sidebar' });
		const htmlPath = join(projectDir, 'templates', 'doc', 'doc.html');
		const content = await readFile(htmlPath, 'utf-8');
		expect(content).toContain('poli-aside');
		expect(content).toContain('poli-header');
		expect(content).toContain('poli-footer');
	});

	it('should throw for unknown model', async () => {
		await expect(
			executeNew('test', { cwd: projectDir, model: 'nonexistent-model' })
		).rejects.toThrow(/Unknown model/);
	});

	it('should accept a --format option', async () => {
		await executeNew('certificate', { cwd: projectDir, format: 'A5', orientation: 'landscape' });
		const manifest = JSON.parse(
			await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
		);
		expect(manifest.templates[0].format).toBe('A5');
		expect(manifest.templates[0].orientation).toBe('landscape');
	});

	it('should throw if template name already exists in manifest', async () => {
		await executeNew('invoice', { cwd: projectDir });
		await expect(executeNew('invoice', { cwd: projectDir })).rejects.toThrow(
			/already exists/
		);
	});

	it('should throw if no poli-page.json is found', async () => {
		const emptyDir = await mkdtemp(join(tmpdir(), 'poli-empty-'));
		await expect(executeNew('invoice', { cwd: emptyDir })).rejects.toThrow(
			/poli-page\.json/
		);
		await rm(emptyDir, { recursive: true, force: true });
	});

	it('should sanitize template name to kebab-case', async () => {
		await executeNew('My Invoice', { cwd: projectDir });
		const manifest = JSON.parse(
			await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
		);
		expect(manifest.templates[0].name).toBe('my-invoice');

		const htmlPath = join(projectDir, 'templates', 'my-invoice', 'my-invoice.html');
		const stats = await stat(htmlPath);
		expect(stats.isFile()).toBe(true);
	});

	describe('getAvailableModels', () => {
		it('should return all 6 structure models', () => {
			const models = getAvailableModels();
			expect(models).toContain('blank');
			expect(models).toContain('header-main-footer');
			expect(models).toContain('header-main-footer-sidebar');
			expect(models).toContain('header-main-sidebar-footer');
			expect(models).toContain('header-sidebar-main-footer');
			expect(models).toContain('sidebar-header-main-footer');
			expect(models).toHaveLength(6);
		});
	});
});
