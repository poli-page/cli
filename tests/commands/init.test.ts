import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../../src/commands/init.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';
import type {
	Fetcher,
	TemplateIndex,
	TemplateManifest,
} from '../../src/template-importer.js';

const INDEX: TemplateIndex = {
	$schema: 'poli-page/templates/v1',
	collections: {
		showcase: {
			title: 'Showcase',
			description: 'Production templates',
			templates: [{ name: 'invoice', description: 'Invoice' }],
		},
	},
};

const SHOWCASE_INVOICE: TemplateManifest = {
	template: {
		name: 'invoice',
		template: 'invoice.html',
		mock: 'invoice.json',
		format: 'A4',
		orientation: 'portrait',
	},
	images: [],
	fonts: [],
};

const SOURCE_FILES: Record<string, string> = {
	'index.json': JSON.stringify(INDEX),
	'showcase/templates/invoice/manifest.json': JSON.stringify(SHOWCASE_INVOICE),
	'showcase/templates/invoice/invoice.html': '<div>Invoice</div>',
	'showcase/templates/invoice/invoice.json': '{"company":"Acme"}',
	'showcase/templates/invoice/tailwind-additions.css':
		'@theme { --color-accent: #e2725b; }',
};

function makeFetcher(files: Record<string, string>): Fetcher {
	return async (url: string) => {
		const m = url.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/(.+)$/);
		if (!m) return new Response('not found', { status: 404 });
		const content = files[m[1]];
		if (content === undefined) return new Response('not found', { status: 404 });
		return new Response(content, { status: 200 });
	};
}

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

	describe('with --with-template', () => {
		let fakeHome: string;

		beforeEach(async () => {
			fakeHome = await mkdtemp(join(tmpdir(), 'poli-init-home-'));
		});

		afterEach(async () => {
			await rm(fakeHome, { recursive: true, force: true });
		});

		it('imports the template after scaffolding the project', async () => {
			const projectDir = await executeInit('billing', {
				cwd: tempDir,
				withTemplate: 'showcase/invoice',
				homeDir: fakeHome,
				fetcher: makeFetcher(SOURCE_FILES),
			});

			// Project scaffold
			const stats = await stat(projectDir);
			expect(stats.isDirectory()).toBe(true);

			// Imported template directory
			await stat(join(projectDir, 'templates', 'invoice', 'invoice.html'));

			// Manifest contains the template entry
			const manifest = JSON.parse(
				await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
			);
			expect(manifest.templates).toHaveLength(1);
			expect(manifest.templates[0].name).toBe('invoice');

			// Tailwind appended with markers
			const tw = await readFile(join(projectDir, 'tailwind.css'), 'utf-8');
			expect(tw).toMatch(/poli-page-additions: showcase\/invoice — start/);
		});

		it('renames the imported template via --template-name', async () => {
			const projectDir = await executeInit('billing', {
				cwd: tempDir,
				withTemplate: 'showcase/invoice',
				templateName: 'welcome',
				homeDir: fakeHome,
				fetcher: makeFetcher(SOURCE_FILES),
			});

			await stat(join(projectDir, 'templates', 'welcome', 'invoice.html'));
			const manifest = JSON.parse(
				await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
			);
			expect(manifest.templates[0].name).toBe('welcome');
		});

		it('throws if the template ref is malformed', async () => {
			await expect(
				executeInit('billing', {
					cwd: tempDir,
					withTemplate: 'just-one-segment',
					homeDir: fakeHome,
					fetcher: makeFetcher(SOURCE_FILES),
				})
			).rejects.toThrow(/template reference/i);
		});

		it('throws if the template is unknown in the source', async () => {
			await expect(
				executeInit('billing', {
					cwd: tempDir,
					withTemplate: 'showcase/banana',
					homeDir: fakeHome,
					fetcher: makeFetcher(SOURCE_FILES),
				})
			).rejects.toThrow(/banana/i);
		});

		it('passes --source through to a third-party repo', async () => {
			const calls: string[] = [];
			const customFetcher: Fetcher = async (url) => {
				calls.push(url);
				return makeFetcher(SOURCE_FILES)(url);
			};
			await executeInit('billing', {
				cwd: tempDir,
				withTemplate: 'showcase/invoice',
				source: 'github:acme/my-templates',
				homeDir: fakeHome,
				fetcher: customFetcher,
			});
			expect(calls.some((u) => u.includes('acme/my-templates'))).toBe(true);
		});
	});
});
