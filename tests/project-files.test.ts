import { describe, it, expect } from 'vitest';
import {
	isAcceptedProjectPath,
	projectFileEncoding,
	toProjectFileEntries,
} from '../src/project-files.js';

describe('isAcceptedProjectPath — the file set the API accepts', () => {
	it.each([
		'poli-page.json',
		'tailwind.css',
		'templates/invoice/invoice.html',
		'templates/invoice/invoice.json',
		'templates/invoice/tailwind-additions.css',
		'templates/invoice/manifest.json',
		'templates/invoice/sections/header.html',
		'templates/invoice-2024/invoice-2024.html',
		'partials/header.html',
		'partials/blocks/footer.html',
		'assets/images/logo.png',
		'assets/images/brand/logo.svg',
		'assets/icons/check.svg',
		'assets/fonts/dm-sans.woff2',
		'assets/fonts/inter/inter-400.woff',
		'assets/fonts/a.ttf',
		'assets/fonts/a.OTF',
	])('accepts %s', (path) => {
		expect(isAcceptedProjectPath(path)).toBe(true);
	});

	it.each([
		'.gitignore',
		'.prettierignore',
		'README.md',
		'package.json',
		'new.json',
		'styles.css',
		'index.html',
		'templates/invoice.html',
		'templates/Invoice/Invoice.html',
		'templates/-invoice/-invoice.html',
		'templates/invoice/notes.md',
		'templates/invoice/logo.png',
		'partials/header.json',
		'partials/style.css',
		'assets/logo.png',
		'assets/images',
		'assets/fonts/readme.txt',
		'assets/fonts/inter.css',
		'assets/videos/intro.mp4',
		'output/invoice/a4-portrait/invoice.pdf',
		'node_modules/pkg/index.html',
		'sub/poli-page.json',
		'sub/tailwind.css',
	])('refuses %s', (path) => {
		expect(isAcceptedProjectPath(path)).toBe(false);
	});
});

describe('projectFileEncoding', () => {
	it.each([
		'assets/images/logo.png',
		'assets/images/logo.svg',
		'assets/icons/a.svg',
		'assets/fonts/a.woff2',
	])('sends %s as base64', (path) => {
		expect(projectFileEncoding(path)).toBe('base64');
	});

	it.each([
		'poli-page.json',
		'tailwind.css',
		'templates/invoice/invoice.html',
		'templates/invoice/invoice.json',
		'templates/invoice/tailwind-additions.css',
		'partials/header.html',
	])('sends %s as utf8', (path) => {
		expect(projectFileEncoding(path)).toBe('utf8');
	});
});

describe('toProjectFileEntries', () => {
	it('builds one { path, encoding, content } entry per file, sorted by path', () => {
		const files = new Map([
			['templates/invoice/invoice.html', '<h1>x</h1>'],
			['assets/images/logo.png', 'iVBORw=='],
			['poli-page.json', '{}'],
		]);
		expect(toProjectFileEntries(files)).toEqual([
			{ path: 'assets/images/logo.png', encoding: 'base64', content: 'iVBORw==' },
			{ path: 'poli-page.json', encoding: 'utf8', content: '{}' },
			{ path: 'templates/invoice/invoice.html', encoding: 'utf8', content: '<h1>x</h1>' },
		]);
	});
});
