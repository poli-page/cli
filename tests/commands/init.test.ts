import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../../src/commands/init.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';

describe('poli init', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-init-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('should create a project directory with the given name', async () => {
		await executeInit('my-invoices', { cwd: tempDir });
		const projectDir = join(tempDir, 'my-invoices');
		const stats = await stat(projectDir);
		expect(stats.isDirectory()).toBe(true);
	});

	it('should create a valid poli-page.json manifest', async () => {
		await executeInit('billing-templates', { cwd: tempDir });
		const manifestPath = join(tempDir, 'billing-templates', MANIFEST_FILENAME);
		const content = await readFile(manifestPath, 'utf-8');
		const manifest = JSON.parse(content);

		expect(manifest.project.name).toBe('billing-templates');
		expect(manifest.project.version).toBe('1.0');
		expect(manifest.templates).toEqual([]);
		expect(manifest.fonts).toEqual([]);
	});

	it('should create a templates/ directory', async () => {
		await executeInit('my-project', { cwd: tempDir });
		const templatesDir = join(tempDir, 'my-project', 'templates');
		const stats = await stat(templatesDir);
		expect(stats.isDirectory()).toBe(true);
	});

	it('should create an assets/ directory', async () => {
		await executeInit('my-project', { cwd: tempDir });
		const assetsDir = join(tempDir, 'my-project', 'assets');
		const stats = await stat(assetsDir);
		expect(stats.isDirectory()).toBe(true);
	});

	it('should create an assets/fonts/ directory', async () => {
		await executeInit('my-project', { cwd: tempDir });
		const fontsDir = join(tempDir, 'my-project', 'assets', 'fonts');
		const stats = await stat(fontsDir);
		expect(stats.isDirectory()).toBe(true);
	});

	it('should create an assets/images/ directory', async () => {
		await executeInit('my-project', { cwd: tempDir });
		const imagesDir = join(tempDir, 'my-project', 'assets', 'images');
		const stats = await stat(imagesDir);
		expect(stats.isDirectory()).toBe(true);
	});

	it('should create a partials/ directory', async () => {
		await executeInit('my-project', { cwd: tempDir });
		const partialsDir = join(tempDir, 'my-project', 'partials');
		const stats = await stat(partialsDir);
		expect(stats.isDirectory()).toBe(true);
	});

	it('should create a tailwind.css file', async () => {
		await executeInit('my-project', { cwd: tempDir });
		const tailwindPath = join(tempDir, 'my-project', 'tailwind.css');
		const content = await readFile(tailwindPath, 'utf-8');
		expect(content).toContain('@theme');
	});

	it('should create a .gitignore file', async () => {
		await executeInit('my-project', { cwd: tempDir });
		const gitignorePath = join(tempDir, 'my-project', '.gitignore');
		const content = await readFile(gitignorePath, 'utf-8');
		expect(content).toContain('node_modules');
		expect(content).toContain('output/');
	});

	it('should throw if the directory already exists', async () => {
		await executeInit('existing', { cwd: tempDir });
		await expect(executeInit('existing', { cwd: tempDir })).rejects.toThrow(
			/already exists/
		);
	});

	it('should sanitize the project name to lowercase kebab-case', async () => {
		await executeInit('My Cool Project', { cwd: tempDir });
		const projectDir = join(tempDir, 'my-cool-project');
		const stats = await stat(projectDir);
		expect(stats.isDirectory()).toBe(true);

		const manifest = JSON.parse(
			await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
		);
		expect(manifest.project.name).toBe('my-cool-project');
	});

	it('should initialize in the current directory when name is "."', async () => {
		await executeInit('.', { cwd: tempDir });
		const manifestPath = join(tempDir, MANIFEST_FILENAME);
		const content = await readFile(manifestPath, 'utf-8');
		const manifest = JSON.parse(content);

		expect(manifest.project.name).toBe(tempDir.split('/').pop());
	});
});
