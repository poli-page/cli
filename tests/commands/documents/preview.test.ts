import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	executeDocumentsPreview,
	injectPreviewCsp,
} from '../../../src/commands/documents/preview.js';
import { DocumentNotFoundError, type ApiClient } from '../../../src/api-client.js';
import { createFakeApiClient } from '../../helpers/fake-api-client.js';
import { testApiKey } from '../../helpers/api-key.js';

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">`;

function makeStubClient(overrides: Partial<ApiClient> = {}): ApiClient {
	return createFakeApiClient({
		documentPreview: async () => ({
			html: '<html>fake preview</html>',
			pageCount: 4,
		}),
		...overrides,
	});
}

describe('executeDocumentsPreview', () => {
	let tempDir: string;
	let fakeHome: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-docs-prev-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-docs-prev-home-'));
		savedEnv = process.env.POLI_PAGE_API_KEY;
		process.env.POLI_PAGE_API_KEY = testApiKey('live');
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
		if (savedEnv === undefined) {
			delete process.env.POLI_PAGE_API_KEY;
		} else {
			process.env.POLI_PAGE_API_KEY = savedEnv;
		}
	});

	it('writes HTML to ./output/documents/<id>.preview.html by default', async () => {
		const result = await executeDocumentsPreview('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: makeStubClient(),
			noOpen: true,
		});

		expect(result.path).toBe(join(tempDir, 'output', 'documents', 'doc_abc.preview.html'));
		expect(result.html).toBe('<html>fake preview</html>');
		expect(result.pageCount).toBe(4);
		const written = await readFile(result.path!, 'utf-8');
		expect(written).toBe(`<html><head>${CSP_META}</head>fake preview</html>`);
	});

	it('writes HTML to a custom path when -o is provided', async () => {
		const customPath = join(tempDir, 'preview.html');
		const result = await executeDocumentsPreview('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: makeStubClient(),
			output: customPath,
			noOpen: true,
		});

		expect(result.path).toBe(customPath);
		const written = await readFile(customPath, 'utf-8');
		expect(written).toBe(`<html><head>${CSP_META}</head>fake preview</html>`);
	});

	it('writes the CSP meta as the first child of an existing <head>', async () => {
		const html =
			'<!DOCTYPE html><html lang="en"><head><title>t</title><script>alert(1)</script></head><body></body></html>';
		const result = await executeDocumentsPreview('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: makeStubClient({
				documentPreview: async () => ({ html, pageCount: 1 }),
			}),
			noOpen: true,
		});

		const written = await readFile(result.path!, 'utf-8');
		expect(written).toBe(
			`<!DOCTYPE html><html lang="en"><head>${CSP_META}<title>t</title><script>alert(1)</script></head><body></body></html>`
		);
		expect(result.html).toBe(html);
	});

	it('returns html + pageCount without writing when json mode is set', async () => {
		const result = await executeDocumentsPreview('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: makeStubClient(),
			json: true,
		});

		expect(result.path).toBeUndefined();
		expect(result.html).toBe('<html>fake preview</html>');
		expect(result.pageCount).toBe(4);
	});

	it('calls openFn with the file path when noOpen is false', async () => {
		const openFn = vi.fn().mockResolvedValue(undefined);
		const result = await executeDocumentsPreview('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: makeStubClient(),
			openFn,
		});

		expect(openFn).toHaveBeenCalledWith(result.path);
	});

	it('skips openFn when noOpen is true', async () => {
		const openFn = vi.fn();
		await executeDocumentsPreview('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: makeStubClient(),
			openFn,
			noOpen: true,
		});

		expect(openFn).not.toHaveBeenCalled();
	});

	it('propagates DocumentNotFoundError', async () => {
		const client = makeStubClient({
			documentPreview: async () => {
				throw new DocumentNotFoundError('not found');
			},
		});

		await expect(
			executeDocumentsPreview('doc_missing', {
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: client,
				noOpen: true,
			})
		).rejects.toBeInstanceOf(DocumentNotFoundError);
	});
});

describe('injectPreviewCsp', () => {
	it('creates a <head> when the input has none', () => {
		expect(injectPreviewCsp('<!doctype html><html><body>x</body></html>')).toBe(
			`<!doctype html><html><head>${CSP_META}</head><body>x</body></html>`
		);
		expect(injectPreviewCsp('<p>x</p>')).toBe(`<head>${CSP_META}</head><p>x</p>`);
	});

	it('matches <head> with attributes, any case, after BOM, whitespace and comments', () => {
		expect(
			injectPreviewCsp('\uFEFF<!-- c -->\n<HTML data-x="a>b">\n  <HEAD id="h">x</HEAD>')
		).toBe(`\uFEFF<!-- c -->\n<HTML data-x="a>b">\n  <HEAD id="h">${CSP_META}x</HEAD>`);
	});

	it('ignores a <head> inside a comment', () => {
		expect(injectPreviewCsp('<html><!-- <head> --><head></head></html>')).toBe(
			`<html><!-- <head> --><head>${CSP_META}</head></html>`
		);
	});

	it('treats <!--> as an empty comment, not as the start of one', () => {
		expect(injectPreviewCsp('<!--><script>alert(1)</script>--><head></head>')).toBe(
			`<!--><head>${CSP_META}</head><script>alert(1)</script>--><head></head>`
		);
	});

	it('treats <!---> as an empty comment, not as the start of one', () => {
		expect(injectPreviewCsp('<!---><script>alert(1)</script>--><head></head>')).toBe(
			`<!---><head>${CSP_META}</head><script>alert(1)</script>--><head></head>`
		);
	});

	it('ends a comment at --!> as browsers do', () => {
		expect(injectPreviewCsp('<!-- a --!><script>x</script><!-- --><head></head>')).toBe(
			`<!-- a --!><head>${CSP_META}</head><script>x</script><!-- --><head></head>`
		);
	});

	it('does not take <header> or a later <head> for the document head', () => {
		expect(injectPreviewCsp('<html><header></header>')).toBe(
			`<html><head>${CSP_META}</head><header></header>`
		);
		expect(injectPreviewCsp('<html><script>x</script><head></head>')).toBe(
			`<html><head>${CSP_META}</head><script>x</script><head></head>`
		);
	});
});

describe('injectPreviewCsp, parsing tags as browsers do', () => {
	it('reads a quote inside an attribute name as part of the name', () => {
		expect(injectPreviewCsp(`<head a'><script>alert('1')</script></head>`)).toBe(
			`<head a'>${CSP_META}<script>alert('1')</script></head>`
		);
		expect(injectPreviewCsp(`<html a"><script>alert("1")</script><head></head>`)).toBe(
			`<html a"><head>${CSP_META}</head><script>alert("1")</script><head></head>`
		);
	});

	it('does not take a custom element named head-x or html-x for <head> or <html>', () => {
		expect(injectPreviewCsp('<html><head-x><script>x</script></head-x>')).toBe(
			`<html><head>${CSP_META}</head><head-x><script>x</script></head-x>`
		);
		expect(injectPreviewCsp('<html-x><script>x</script><head></head>')).toBe(
			`<head>${CSP_META}</head><html-x><script>x</script><head></head>`
		);
	});

	it('skips only HTML whitespace before <head>', () => {
		expect(injectPreviewCsp('\u00A0<head><script>x</script></head>')).toBe(
			`<head>${CSP_META}</head>\u00A0<head><script>x</script></head>`
		);
		expect(injectPreviewCsp('\t\n\f\r <head></head>')).toBe(
			`\t\n\f\r <head>${CSP_META}</head>`
		);
	});

	it('ends a tag at > after an unquoted, self-closing or missing attribute value', () => {
		expect(injectPreviewCsp('<html a=x/ d = "e>f" b= c=><head/ id=h>x')).toBe(
			`<html a=x/ d = "e>f" b= c=><head/ id=h>${CSP_META}x`
		);
		expect(injectPreviewCsp('<head/="a>b">x')).toBe(`<head/="a>${CSP_META}b">x`);
	});

	it('creates a <head> before a tag whose quoted value never closes', () => {
		expect(injectPreviewCsp('<head a="x><script>x</script>')).toBe(
			`<head>${CSP_META}</head><head a="x><script>x</script>`
		);
	});
});
