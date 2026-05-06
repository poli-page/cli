import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	parseSource,
	parseTemplateRef,
	DEFAULT_SOURCE,
	importTemplate,
	type Fetcher,
	type ConflictHandler,
	type TemplateIndex,
	type TemplateManifest,
} from '../src/template-importer.js';
import { writeManifest, readManifest } from '../src/manifest.js';

function makeFetcher(files: Record<string, string | Buffer>): Fetcher {
	return async (url: string): Promise<Response> => {
		// Match raw.githubusercontent.com URLs: https://raw.githubusercontent.com/<owner>/<repo>/main/<path>
		const m = url.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/(.+)$/);
		if (!m) {
			return new Response('not found', { status: 404 });
		}
		const path = m[1];
		const content = files[path];
		if (content === undefined) {
			return new Response('not found', { status: 404 });
		}
		const body = typeof content === 'string' ? content : content;
		return new Response(body, { status: 200 });
	};
}

const MINIMAL_INDEX: TemplateIndex = {
	$schema: 'poli-page/templates/v1',
	collections: {
		showcase: {
			title: 'Showcase',
			description: 'Production-grade templates',
			templates: [
				{ name: 'invoice', description: 'Invoice template' },
				{ name: 'report', description: 'Report template' },
			],
		},
	},
};

const INVOICE_MANIFEST: TemplateManifest = {
	template: {
		name: 'invoice',
		template: 'invoice.html',
		mock: 'invoice.json',
		format: 'A4',
		orientation: 'portrait',
	},
	images: ['logo.png'],
	fonts: [
		{ family: 'DM Sans', src: 'fonts/dm-sans.woff2', weight: 400 },
		{ family: 'DM Sans', src: 'fonts/dm-sans.woff2', weight: 700 },
	],
};

async function setupBlankProject(): Promise<{ projectDir: string; fakeHome: string }> {
	const projectDir = await mkdtemp(join(tmpdir(), 'poli-importer-proj-'));
	const fakeHome = await mkdtemp(join(tmpdir(), 'poli-importer-home-'));
	await mkdir(join(projectDir, 'templates'), { recursive: true });
	await mkdir(join(projectDir, 'assets', 'fonts'), { recursive: true });
	await mkdir(join(projectDir, 'assets', 'images'), { recursive: true });
	await writeFile(join(projectDir, 'tailwind.css'), '@import "tailwindcss";\n', 'utf-8');
	await writeManifest(projectDir, {
		project: { name: 'test-project', version: '0.1.0' },
		fonts: [],
		templates: [],
	});
	return { projectDir, fakeHome };
}

function fullSource(): Record<string, string | Buffer> {
	return {
		'index.json': JSON.stringify(MINIMAL_INDEX),
		'showcase/templates/invoice/manifest.json': JSON.stringify(INVOICE_MANIFEST),
		'showcase/templates/invoice/invoice.html': '<div>Invoice {{ number }}</div>',
		'showcase/templates/invoice/invoice.json': JSON.stringify({ number: 'INV-001' }),
		'showcase/templates/invoice/tailwind-additions.css':
			'@theme { --font-sans: "DM Sans"; }',
		'showcase/assets/fonts/dm-sans.woff2': Buffer.from('FAKE_FONT_BYTES'),
		'showcase/assets/images/logo.png': Buffer.from('FAKE_PNG_BYTES'),
	};
}

describe('template-importer — parsing helpers', () => {
	describe('parseSource', () => {
		it('parses github:owner/repo', () => {
			expect(parseSource('github:poli-page/templates')).toEqual({
				owner: 'poli-page',
				repo: 'templates',
			});
		});

		it('parses bare owner/repo', () => {
			expect(parseSource('foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
		});

		it('rejects malformed input', () => {
			expect(() => parseSource('not-a-source')).toThrow(/source/i);
			expect(() => parseSource('github:onlyone')).toThrow(/source/i);
		});
	});

	describe('parseTemplateRef', () => {
		it('parses collection/template', () => {
			expect(parseTemplateRef('showcase/invoice')).toEqual({
				collection: 'showcase',
				name: 'invoice',
			});
		});

		it('rejects malformed input', () => {
			expect(() => parseTemplateRef('justone')).toThrow(/template reference/i);
			expect(() => parseTemplateRef('a/b/c')).toThrow(/template reference/i);
		});
	});

	it('exposes DEFAULT_SOURCE pointing at poli-page/templates', () => {
		expect(DEFAULT_SOURCE).toEqual({ owner: 'poli-page', repo: 'templates' });
	});
});

describe('importTemplate — happy path', () => {
	let projectDir: string;
	let fakeHome: string;

	beforeEach(async () => {
		({ projectDir, fakeHome } = await setupBlankProject());
	});

	afterEach(async () => {
		await rm(projectDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	it('copies template files, fonts, images and merges into poli-page.json', async () => {
		const result = await importTemplate({
			templateRef: { collection: 'showcase', name: 'invoice' },
			projectDir,
			homeDir: fakeHome,
			fetcher: makeFetcher(fullSource()),
		});

		expect(result.destTemplateName).toBe('invoice');
		expect(result.copiedImages).toEqual(['logo.png']);
		expect(result.copiedFonts).toEqual(['dm-sans.woff2']);
		expect(result.appendedTailwind).toBe(true);

		// Files copied
		const html = await readFile(join(projectDir, 'templates', 'invoice', 'invoice.html'), 'utf-8');
		expect(html).toContain('Invoice');
		const mock = await readFile(join(projectDir, 'templates', 'invoice', 'invoice.json'), 'utf-8');
		expect(JSON.parse(mock)).toEqual({ number: 'INV-001' });

		// Image copied
		const img = await readFile(join(projectDir, 'assets', 'images', 'logo.png'));
		expect(img.toString()).toBe('FAKE_PNG_BYTES');

		// Font copied (basename preserved relative to assets/)
		const font = await readFile(join(projectDir, 'assets', 'fonts', 'dm-sans.woff2'));
		expect(font.toString()).toBe('FAKE_FONT_BYTES');

		// Manifest merged
		const manifest = await readManifest(projectDir);
		expect(manifest.templates).toHaveLength(1);
		expect(manifest.templates![0]).toMatchObject({
			name: 'invoice',
			template: 'invoice.html',
			mock: 'invoice.json',
			format: 'A4',
			orientation: 'portrait',
		});
		expect(manifest.fonts).toHaveLength(2);
		expect(manifest.fonts![0]).toMatchObject({ family: 'DM Sans', weight: 400 });

		// Tailwind appended with markers
		const tw = await readFile(join(projectDir, 'tailwind.css'), 'utf-8');
		expect(tw).toMatch(/poli-page-additions: showcase\/invoice — start/);
		expect(tw).toMatch(/poli-page-additions: showcase\/invoice — end/);
		expect(tw).toContain('--font-sans');
	});

	it('renames the template via destTemplateName', async () => {
		const result = await importTemplate({
			templateRef: { collection: 'showcase', name: 'invoice' },
			destTemplateName: 'welcome',
			projectDir,
			homeDir: fakeHome,
			fetcher: makeFetcher(fullSource()),
		});

		expect(result.destTemplateName).toBe('welcome');
		// File copied to renamed dir AND renamed to match destName
		await stat(join(projectDir, 'templates', 'welcome', 'welcome.html'));
		await stat(join(projectDir, 'templates', 'welcome', 'welcome.json'));
		// Manifest entry uses the new name AND points at the renamed files
		const manifest = await readManifest(projectDir);
		expect(manifest.templates![0]).toMatchObject({
			name: 'welcome',
			template: 'welcome.html',
			mock: 'welcome.json',
		});
	});

	it('is idempotent for the tailwind block on a re-import of the same source', async () => {
		const opts = {
			templateRef: { collection: 'showcase', name: 'invoice' },
			projectDir,
			homeDir: fakeHome,
			fetcher: makeFetcher(fullSource()),
		};
		await importTemplate(opts);

		// Reset destination template dir to allow re-import (the duplicate-name
		// guard isn't tested here — we only care about tailwind dedup).
		await rm(join(projectDir, 'templates', 'invoice'), { recursive: true });
		// Reset manifest templates[] entry
		const m = await readManifest(projectDir);
		m.templates = [];
		await writeManifest(projectDir, m);

		const result = await importTemplate(opts);

		expect(result.appendedTailwind).toBe(false);
		const tw = await readFile(join(projectDir, 'tailwind.css'), 'utf-8');
		const startCount = (tw.match(/poli-page-additions: showcase\/invoice — start/g) ?? []).length;
		expect(startCount).toBe(1);
	});
});

describe('importTemplate — validation errors', () => {
	let projectDir: string;
	let fakeHome: string;

	beforeEach(async () => {
		({ projectDir, fakeHome } = await setupBlankProject());
	});

	afterEach(async () => {
		await rm(projectDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	it('throws when the collection is unknown', async () => {
		await expect(
			importTemplate({
				templateRef: { collection: 'unknown', name: 'invoice' },
				projectDir,
				homeDir: fakeHome,
				fetcher: makeFetcher(fullSource()),
			})
		).rejects.toThrow(/collection.*unknown/i);
	});

	it('throws when the template is unknown in the collection', async () => {
		await expect(
			importTemplate({
				templateRef: { collection: 'showcase', name: 'banana' },
				projectDir,
				homeDir: fakeHome,
				fetcher: makeFetcher(fullSource()),
			})
		).rejects.toThrow(/banana/i);
	});

	it('throws when the destination template name already exists', async () => {
		await mkdir(join(projectDir, 'templates', 'invoice'), { recursive: true });
		await expect(
			importTemplate({
				templateRef: { collection: 'showcase', name: 'invoice' },
				projectDir,
				homeDir: fakeHome,
				fetcher: makeFetcher(fullSource()),
			})
		).rejects.toThrow(/already exists/i);
	});

	it('throws a clear error when the source is unreachable', async () => {
		await expect(
			importTemplate({
				templateRef: { collection: 'showcase', name: 'invoice' },
				projectDir,
				homeDir: fakeHome,
				fetcher: async () => new Response('boom', { status: 500 }),
			})
		).rejects.toThrow(/500|unreachable|failed/i);
	});
});

describe('importTemplate — asset conflicts', () => {
	let projectDir: string;
	let fakeHome: string;

	beforeEach(async () => {
		({ projectDir, fakeHome } = await setupBlankProject());
	});

	afterEach(async () => {
		await rm(projectDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	it('skips identical files silently without invoking onConflict', async () => {
		await writeFile(
			join(projectDir, 'assets', 'images', 'logo.png'),
			Buffer.from('FAKE_PNG_BYTES')
		);
		const calls: unknown[] = [];
		const onConflict: ConflictHandler = async (info) => {
			calls.push(info);
			return 'overwrite';
		};

		await importTemplate({
			templateRef: { collection: 'showcase', name: 'invoice' },
			projectDir,
			homeDir: fakeHome,
			fetcher: makeFetcher(fullSource()),
			onConflict,
		});

		expect(calls).toHaveLength(0);
	});

	it('asks onConflict for differing content, then overwrites when told', async () => {
		await writeFile(
			join(projectDir, 'assets', 'images', 'logo.png'),
			Buffer.from('OLD_LOGO_BYTES')
		);
		const onConflict: ConflictHandler = async () => 'overwrite';

		await importTemplate({
			templateRef: { collection: 'showcase', name: 'invoice' },
			projectDir,
			homeDir: fakeHome,
			fetcher: makeFetcher(fullSource()),
			onConflict,
		});

		const img = await readFile(join(projectDir, 'assets', 'images', 'logo.png'));
		expect(img.toString()).toBe('FAKE_PNG_BYTES');
	});

	it('keeps the existing file when onConflict returns skip', async () => {
		await writeFile(
			join(projectDir, 'assets', 'images', 'logo.png'),
			Buffer.from('OLD_LOGO_BYTES')
		);
		const onConflict: ConflictHandler = async () => 'skip';

		await importTemplate({
			templateRef: { collection: 'showcase', name: 'invoice' },
			projectDir,
			homeDir: fakeHome,
			fetcher: makeFetcher(fullSource()),
			onConflict,
		});

		const img = await readFile(join(projectDir, 'assets', 'images', 'logo.png'));
		expect(img.toString()).toBe('OLD_LOGO_BYTES');
	});

	it('writes a numbered duplicate when onConflict returns duplicate', async () => {
		await writeFile(
			join(projectDir, 'assets', 'images', 'logo.png'),
			Buffer.from('OLD_LOGO_BYTES')
		);
		const onConflict: ConflictHandler = async () => 'duplicate';

		await importTemplate({
			templateRef: { collection: 'showcase', name: 'invoice' },
			projectDir,
			homeDir: fakeHome,
			fetcher: makeFetcher(fullSource()),
			onConflict,
		});

		const original = await readFile(join(projectDir, 'assets', 'images', 'logo.png'));
		expect(original.toString()).toBe('OLD_LOGO_BYTES');
		const duplicated = await readFile(join(projectDir, 'assets', 'images', 'logo-2.png'));
		expect(duplicated.toString()).toBe('FAKE_PNG_BYTES');
	});

	it('defaults to skip+warn when no onConflict handler is provided', async () => {
		await writeFile(
			join(projectDir, 'assets', 'images', 'logo.png'),
			Buffer.from('OLD_LOGO_BYTES')
		);

		await importTemplate({
			templateRef: { collection: 'showcase', name: 'invoice' },
			projectDir,
			homeDir: fakeHome,
			fetcher: makeFetcher(fullSource()),
		});

		const img = await readFile(join(projectDir, 'assets', 'images', 'logo.png'));
		expect(img.toString()).toBe('OLD_LOGO_BYTES');
	});
});
