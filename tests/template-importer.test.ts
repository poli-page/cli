import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	parseSource,
	parseTemplateRef,
	DEFAULT_SOURCE,
	fetchStarter,
	fetchTemplateIndex,
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
		project: { name: 'test-project' },
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

		it('accepts a repo name that starts with a dot', () => {
			expect(parseSource('poli-page/.github')).toEqual({ owner: 'poli-page', repo: '.github' });
		});

		it.each(['x/..', 'x/.', '../templates', 'a\\..\\poli-page/templates', 'x/a?b', 'x/%2e%2e'])(
			'rejects an owner or repo that is not one plain name (%s)',
			(spec) => {
				expect(() => parseSource(spec)).toThrow(/Invalid source/);
			}
		);
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

	it('does not give a numbered duplicate the name of another image of the same import', async () => {
		await writeFile(
			join(projectDir, 'assets', 'images', 'logo.png'),
			Buffer.from('OLD_LOGO_BYTES')
		);
		const files = fullSource();
		files['showcase/templates/invoice/manifest.json'] = JSON.stringify({
			...INVOICE_MANIFEST,
			images: ['logo.png', 'logo-2.png'],
		});
		files['showcase/assets/images/logo-2.png'] = Buffer.from('SECOND_PNG_BYTES');
		const conflicts: string[] = [];
		const onConflict: ConflictHandler = async (info) => {
			conflicts.push(info.filename);
			return 'duplicate';
		};

		const result = await importTemplate({
			templateRef: { collection: 'showcase', name: 'invoice' },
			projectDir,
			homeDir: fakeHome,
			fetcher: makeFetcher(files),
			onConflict,
		});

		const images = join(projectDir, 'assets', 'images');
		expect((await readFile(join(images, 'logo.png'))).toString()).toBe('OLD_LOGO_BYTES');
		expect((await readFile(join(images, 'logo-2.png'))).toString()).toBe('FAKE_PNG_BYTES');
		expect((await readFile(join(images, 'logo-2-2.png'))).toString()).toBe('SECOND_PNG_BYTES');
		expect(conflicts).toEqual(['logo.png', 'logo-2.png']);
		expect(result.copiedImages).toEqual(['logo-2.png', 'logo-2-2.png']);
	});

	it('skips the name of an image planned earlier in the import when numbering a duplicate', async () => {
		await writeFile(
			join(projectDir, 'assets', 'images', 'logo.png'),
			Buffer.from('OLD_LOGO_BYTES')
		);
		const files = fullSource();
		files['showcase/templates/invoice/manifest.json'] = JSON.stringify({
			...INVOICE_MANIFEST,
			images: ['logo-2.png', 'logo.png'],
		});
		files['showcase/assets/images/logo-2.png'] = Buffer.from('SECOND_PNG_BYTES');

		const result = await importTemplate({
			templateRef: { collection: 'showcase', name: 'invoice' },
			projectDir,
			homeDir: fakeHome,
			fetcher: makeFetcher(files),
			onConflict: async () => 'duplicate',
		});

		const images = join(projectDir, 'assets', 'images');
		expect((await readFile(join(images, 'logo.png'))).toString()).toBe('OLD_LOGO_BYTES');
		expect((await readFile(join(images, 'logo-2.png'))).toString()).toBe('SECOND_PNG_BYTES');
		expect((await readFile(join(images, 'logo-3.png'))).toString()).toBe('FAKE_PNG_BYTES');
		expect(result.copiedImages).toEqual(['logo-2.png', 'logo-3.png']);
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

describe('importTemplate — paths from the source', () => {
	let projectDir: string;
	let fakeHome: string;
	let outsideDir: string;

	beforeEach(async () => {
		({ projectDir, fakeHome } = await setupBlankProject());
		outsideDir = await mkdtemp(join(tmpdir(), 'poli-importer-outside-'));
	});

	afterEach(async () => {
		await rm(projectDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
		await rm(outsideDir, { recursive: true, force: true });
	});

	async function listFiles(dir: string): Promise<string[]> {
		const entries = await readdir(dir, { recursive: true, withFileTypes: true });
		return entries
			.filter((e) => !e.isDirectory())
			.map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
			.sort();
	}

	function sourceWithManifest(manifest: unknown): Record<string, string | Buffer> {
		return {
			...fullSource(),
			'showcase/templates/invoice/manifest.json': JSON.stringify(manifest),
		};
	}

	function recording(files: Record<string, string | Buffer>, urls: string[]): Fetcher {
		const inner = makeFetcher(files);
		return async (url) => {
			urls.push(url);
			return inner(url);
		};
	}

	async function expectRefusedWithNothingWritten(
		files: Record<string, string | Buffer>,
		error: RegExp,
		cached: string[]
	): Promise<string[]> {
		const projectBefore = await listFiles(projectDir);
		const urls: string[] = [];
		await expect(
			importTemplate({
				templateRef: { collection: 'showcase', name: 'invoice' },
				projectDir,
				homeDir: fakeHome,
				fetcher: recording(files, urls),
			})
		).rejects.toThrow(error);
		expect(await listFiles(projectDir)).toEqual(projectBefore);
		expect(await listFiles(fakeHome)).toEqual(
			cached.map((p) => join('.polipage', 'cache', 'poli-page', 'templates', 'main', p))
		);
		expect(await listFiles(outsideDir)).toEqual([]);
		return urls;
	}

	it.each([
		[
			'template.template',
			{ ...INVOICE_MANIFEST, template: { ...INVOICE_MANIFEST.template, template: 'x?/../../.bashrc' } },
		],
		[
			'template.mock',
			{ ...INVOICE_MANIFEST, template: { ...INVOICE_MANIFEST.template, mock: '../../../mock.json' } },
		],
		[
			'fonts\\[\\]\\.src',
			{
				...INVOICE_MANIFEST,
				fonts: [{ family: 'X', src: '../../.ssh/authorized_keys', weight: 400 }],
			},
		],
		['images\\[\\]', { ...INVOICE_MANIFEST, images: ['logo.png', '../x'] }],
		['images\\[\\]: expected an array', { ...INVOICE_MANIFEST, images: 'logo' }],
		['fonts\\[\\]: expected an array', { ...INVOICE_MANIFEST, fonts: 'x.woff2' }],
		['fonts\\[\\]\\.src', { ...INVOICE_MANIFEST, fonts: [null] }],
		['template.mock', { ...INVOICE_MANIFEST, template: { name: 'invoice', template: 'invoice.html' } }],
	])('refuses an unsafe %s with no file written anywhere', async (field, manifest) => {
		const urls = await expectRefusedWithNothingWritten(
			sourceWithManifest(manifest),
			new RegExp(`Unsafe ${field}`),
			['index.json']
		);
		// Nothing past the manifest is fetched.
		expect(urls.map((u) => u.split('/main/')[1])).toEqual([
			'index.json',
			'showcase/templates/invoice/manifest.json',
		]);
	});

	it('refuses a poisoned manifest already in the cache', async () => {
		const cacheDir = join(fakeHome, '.polipage', 'cache', 'poli-page', 'templates', 'main');
		const cachedManifest = join(cacheDir, 'showcase', 'templates', 'invoice', 'manifest.json');
		await mkdir(join(cachedManifest, '..'), { recursive: true });
		await writeFile(
			cachedManifest,
			JSON.stringify({ ...INVOICE_MANIFEST, images: ['../../../../evil'] })
		);
		await expect(
			importTemplate({
				templateRef: { collection: 'showcase', name: 'invoice' },
				projectDir,
				homeDir: fakeHome,
				fetcher: makeFetcher(fullSource()),
			})
		).rejects.toThrow(/Unsafe images\[\]/);
	});

	it.each([
		['collection', { collections: { '..': MINIMAL_INDEX.collections.showcase, ...MINIMAL_INDEX.collections } }],
		[
			'template',
			{
				collections: {
					showcase: {
						...MINIMAL_INDEX.collections.showcase,
						templates: [
							...MINIMAL_INDEX.collections.showcase.templates,
							{ name: '../../../../.bashrc', description: '' },
						],
					},
				},
			},
		],
	])('refuses an index.json with an unsafe %s name, with no file written', async (kind, index) => {
		const files = { ...fullSource(), 'index.json': JSON.stringify(index) };
		const urls = await expectRefusedWithNothingWritten(
			files,
			new RegExp(`Unsafe ${kind} name`),
			[]
		);
		expect(urls).toHaveLength(1);
		await expect(
			fetchTemplateIndex(DEFAULT_SOURCE, { homeDir: fakeHome, fetcher: makeFetcher(files) })
		).rejects.toThrow(new RegExp(`Unsafe ${kind} name`));
	});

	it('does not take a collection from the prototype chain', async () => {
		await expect(
			importTemplate({
				templateRef: { collection: 'constructor', name: 'invoice' },
				projectDir,
				homeDir: fakeHome,
				fetcher: makeFetcher(fullSource()),
			})
		).rejects.toThrow(/Unknown collection "constructor"/);
	});

	it('refuses an assets folder symlinked out of the project before writing any asset', async () => {
		await rm(join(projectDir, 'assets', 'images'), { recursive: true });
		await symlink(outsideDir, join(projectDir, 'assets', 'images'));
		await expect(
			importTemplate({
				templateRef: { collection: 'showcase', name: 'invoice' },
				projectDir,
				homeDir: fakeHome,
				fetcher: makeFetcher(fullSource()),
			})
		).rejects.toThrow(/outside/);
		expect(await listFiles(outsideDir)).toEqual([]);
		// The fonts come first in the import; they are refused with it.
		expect(await listFiles(join(projectDir, 'assets', 'fonts'))).toEqual([]);
		await expect(stat(join(projectDir, 'templates', 'invoice'))).rejects.toThrow();
	});

	it('refuses an assets root symlinked out of the project before writing any asset', async () => {
		await rm(join(projectDir, 'assets'), { recursive: true });
		await mkdir(join(outsideDir, 'fonts'));
		await mkdir(join(outsideDir, 'images'));
		await symlink(outsideDir, join(projectDir, 'assets'));
		await expect(
			importTemplate({
				templateRef: { collection: 'showcase', name: 'invoice' },
				projectDir,
				homeDir: fakeHome,
				fetcher: makeFetcher(fullSource()),
			})
		).rejects.toThrow(/outside/);
		expect(await listFiles(outsideDir)).toEqual([]);
		await expect(stat(join(projectDir, 'templates', 'invoice'))).rejects.toThrow();
	});

	it.each(['tailwind.css', 'poli-page.json'])(
		'refuses a %s symlinked out of the project before the first write',
		async (name) => {
			const outsideFile = join(outsideDir, name);
			await writeFile(outsideFile, await readFile(join(projectDir, name)));
			await rm(join(projectDir, name));
			await symlink(outsideFile, join(projectDir, name));
			const before = await readFile(outsideFile, 'utf-8');
			await expect(
				importTemplate({
					templateRef: { collection: 'showcase', name: 'invoice' },
					projectDir,
					homeDir: fakeHome,
					fetcher: makeFetcher(fullSource()),
				})
			).rejects.toThrow(/outside/);
			expect(await readFile(outsideFile, 'utf-8')).toBe(before);
			expect(await listFiles(join(projectDir, 'assets', 'fonts'))).toEqual([]);
			await expect(stat(join(projectDir, 'templates', 'invoice'))).rejects.toThrow();
		}
	);

	it('refuses a templates folder symlinked out of the project', async () => {
		await rm(join(projectDir, 'templates'), { recursive: true });
		await symlink(outsideDir, join(projectDir, 'templates'));
		await expect(
			importTemplate({
				templateRef: { collection: 'showcase', name: 'invoice' },
				projectDir,
				homeDir: fakeHome,
				fetcher: makeFetcher(fullSource()),
			})
		).rejects.toThrow(/outside/);
		expect(await listFiles(outsideDir)).toEqual([]);
	});

	it('refuses an asset that is a symlink out of the project', async () => {
		await symlink(join(outsideDir, 'logo.png'), join(projectDir, 'assets', 'images', 'logo.png'));
		await expect(
			importTemplate({
				templateRef: { collection: 'showcase', name: 'invoice' },
				projectDir,
				homeDir: fakeHome,
				fetcher: makeFetcher(fullSource()),
			})
		).rejects.toThrow(/outside/);
		expect(await listFiles(outsideDir)).toEqual([]);
	});

	it('refuses a numbered duplicate that is a dangling symlink out of the project', async () => {
		await writeFile(join(projectDir, 'assets', 'images', 'logo.png'), 'OLD');
		await symlink(join(outsideDir, 'pwned'), join(projectDir, 'assets', 'images', 'logo-2.png'));
		await expect(
			importTemplate({
				templateRef: { collection: 'showcase', name: 'invoice' },
				projectDir,
				homeDir: fakeHome,
				fetcher: makeFetcher(fullSource()),
				onConflict: async () => 'duplicate',
			})
		).rejects.toThrow(/outside/);
		expect(await listFiles(outsideDir)).toEqual([]);
		// Refused before the first project write: the fonts come first.
		expect(await listFiles(join(projectDir, 'assets', 'fonts'))).toEqual([]);
		await expect(stat(join(projectDir, 'templates', 'invoice'))).rejects.toThrow();
	});

	it('encodes each segment of the fetch URL', async () => {
		const urls: string[] = [];
		await fetchTemplateIndex(
			{ owner: 'poli-page', repo: 'templates?x=#' },
			{ homeDir: fakeHome, fetcher: recording(fullSource(), urls) }
		);
		expect(urls).toEqual([
			'https://raw.githubusercontent.com/poli-page/templates%3Fx%3D%23/main/index.json',
		]);
	});

	it('encodes the source in the git tree URL of a starter', async () => {
		const urls: string[] = [];
		await expect(
			fetchStarter('getting-started', { owner: 'poli-page', repo: 'templates?x=#' }, {
				homeDir: fakeHome,
				fetcher: recording({}, urls),
			})
		).rejects.toThrow(/HTTP 404/);
		expect(urls).toEqual([
			'https://api.github.com/repos/poli-page/templates%3Fx%3D%23/git/trees/main?recursive=1',
		]);
	});

	it('refuses a source whose cache path leaves the cache', async () => {
		const urls: string[] = [];
		await expect(
			fetchTemplateIndex(
				{ owner: '..', repo: '..' },
				{ homeDir: fakeHome, fetcher: recording(fullSource(), urls) }
			)
		).rejects.toThrow(/outside/);
		expect(urls).toEqual([]);
	});
});
