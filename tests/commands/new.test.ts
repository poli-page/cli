import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeNew } from '../../src/commands/new.js';
import { executeInit } from '../../src/commands/init.js';
import { MANIFEST_FILENAME } from '../../src/constants.js';
import type { Fetcher, TemplateIndex, TemplateManifest } from '../../src/template-importer.js';

const INDEX: TemplateIndex = {
	$schema: 'poli-page/templates/v1',
	collections: {
		showcase: {
			title: 'Showcase',
			description: 'Production templates',
			templates: [
				{ name: 'invoice', description: 'Invoice' },
				{ name: 'report', description: 'Report' },
			],
		},
		structures: {
			title: 'Layouts',
			description: 'Empty layouts',
			templates: [
				{ name: 'blank', description: 'Empty page' },
				{ name: 'header-main-footer', description: 'HMF layout' },
			],
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

const STRUCTURES_BLANK: TemplateManifest = {
	template: {
		name: 'blank',
		template: 'blank.html',
		mock: 'blank.json',
		format: 'A4',
		orientation: 'portrait',
	},
	images: [],
	fonts: [],
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

const SOURCE_FILES: Record<string, string> = {
	'index.json': JSON.stringify(INDEX),
	'showcase/templates/invoice/manifest.json': JSON.stringify(SHOWCASE_INVOICE),
	'showcase/templates/invoice/invoice.html':
		'<div class="poli-header">{{ company }}</div><div class="poli-footer"></div>',
	'showcase/templates/invoice/invoice.json': '{"company":"Acme"}',
	'showcase/templates/invoice/tailwind-additions.css':
		'@theme { --color-accent: #e2725b; }',
	'structures/templates/blank/manifest.json': JSON.stringify(STRUCTURES_BLANK),
	'structures/templates/blank/blank.html': '<div></div>',
	'structures/templates/blank/blank.json': '{}',
	'structures/templates/blank/tailwind-additions.css': '',
};

describe('poli new', () => {
	let tempDir: string;
	let projectDir: string;
	let fakeHome: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-new-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-new-home-'));
		projectDir = await executeInit('test-project', { cwd: tempDir });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	it('imports a template from the source via --from-template', async () => {
		await executeNew('invoice', {
			cwd: projectDir,
			fromTemplate: 'showcase/invoice',
			homeDir: fakeHome,
			fetcher: makeFetcher(SOURCE_FILES),
		});

		const htmlPath = join(projectDir, 'templates', 'invoice', 'invoice.html');
		const stats = await stat(htmlPath);
		expect(stats.isFile()).toBe(true);

		const html = await readFile(htmlPath, 'utf-8');
		expect(html).toContain('poli-header');

		const manifest = JSON.parse(
			await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
		);
		expect(manifest.templates).toHaveLength(1);
		expect(manifest.templates[0]).toMatchObject({
			name: 'invoice',
			template: 'invoice.html',
			mock: 'invoice.json',
			format: 'A4',
			orientation: 'portrait',
		});
	});

	it('renames the destination via the positional name', async () => {
		await executeNew('billing', {
			cwd: projectDir,
			fromTemplate: 'showcase/invoice',
			homeDir: fakeHome,
			fetcher: makeFetcher(SOURCE_FILES),
		});

		await stat(join(projectDir, 'templates', 'billing', 'billing.html'));
		await stat(join(projectDir, 'templates', 'billing', 'billing.json'));
		const manifest = JSON.parse(
			await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
		);
		expect(manifest.templates[0]).toMatchObject({
			name: 'billing',
			template: 'billing.html',
			mock: 'billing.json',
		});
	});

	it('imports the blank structure (replaces the legacy --model blank flow)', async () => {
		await executeNew('simple', {
			cwd: projectDir,
			fromTemplate: 'structures/blank',
			homeDir: fakeHome,
			fetcher: makeFetcher(SOURCE_FILES),
		});
		const html = await readFile(
			join(projectDir, 'templates', 'simple', 'simple.html'),
			'utf-8'
		);
		expect(html).not.toContain('poli-header');
	});

	it('overrides format and orientation when provided', async () => {
		await executeNew('certificate', {
			cwd: projectDir,
			fromTemplate: 'showcase/invoice',
			format: 'A5',
			orientation: 'landscape',
			homeDir: fakeHome,
			fetcher: makeFetcher(SOURCE_FILES),
		});
		const manifest = JSON.parse(
			await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
		);
		expect(manifest.templates[0].format).toBe('A5');
		expect(manifest.templates[0].orientation).toBe('landscape');
	});

	it('throws if --from-template is omitted (no other source mode exists)', async () => {
		await expect(
			executeNew('invoice', {
				cwd: projectDir,
				homeDir: fakeHome,
				fetcher: makeFetcher(SOURCE_FILES),
			})
		).rejects.toThrow(/from-template/i);
	});

	it('throws if the template ref is malformed', async () => {
		await expect(
			executeNew('invoice', {
				cwd: projectDir,
				fromTemplate: 'just-one-segment',
				homeDir: fakeHome,
				fetcher: makeFetcher(SOURCE_FILES),
			})
		).rejects.toThrow(/template reference/i);
	});

	it('throws if the destination name already exists in the project', async () => {
		await executeNew('invoice', {
			cwd: projectDir,
			fromTemplate: 'showcase/invoice',
			homeDir: fakeHome,
			fetcher: makeFetcher(SOURCE_FILES),
		});
		await expect(
			executeNew('invoice', {
				cwd: projectDir,
				fromTemplate: 'showcase/invoice',
				homeDir: fakeHome,
				fetcher: makeFetcher(SOURCE_FILES),
			})
		).rejects.toThrow(/already exists/i);
	});

	it('throws if no poli-page.json is found', async () => {
		const emptyDir = await mkdtemp(join(tmpdir(), 'poli-empty-'));
		await expect(
			executeNew('invoice', {
				cwd: emptyDir,
				fromTemplate: 'showcase/invoice',
				homeDir: fakeHome,
				fetcher: makeFetcher(SOURCE_FILES),
			})
		).rejects.toThrow(/poli-page\.json/i);
		await rm(emptyDir, { recursive: true, force: true });
	});

	it('sanitizes the destination name to kebab-case', async () => {
		await executeNew('My Invoice', {
			cwd: projectDir,
			fromTemplate: 'showcase/invoice',
			homeDir: fakeHome,
			fetcher: makeFetcher(SOURCE_FILES),
		});
		const manifest = JSON.parse(
			await readFile(join(projectDir, MANIFEST_FILENAME), 'utf-8')
		);
		expect(manifest.templates[0].name).toBe('my-invoice');
		await stat(join(projectDir, 'templates', 'my-invoice', 'my-invoice.html'));
	});

	it('passes through --source for third-party repos', async () => {
		const calls: string[] = [];
		const customFetcher: Fetcher = async (url) => {
			calls.push(url);
			return makeFetcher(SOURCE_FILES)(url);
		};
		await executeNew('invoice', {
			cwd: projectDir,
			fromTemplate: 'showcase/invoice',
			source: 'github:acme/my-templates',
			homeDir: fakeHome,
			fetcher: customFetcher,
		});
		expect(calls.some((u) => u.includes('acme/my-templates'))).toBe(true);
	});
});
