import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDocumentsPreview } from '../../../src/commands/documents/preview.js';
import { DocumentNotFoundError, type ApiClient } from '../../../src/api-client.js';
import { createFakeApiClient } from '../../helpers/fake-api-client.js';
import { testApiKey } from '../../helpers/api-key.js';

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
		expect(written).toBe('<html>fake preview</html>');
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
		expect(written).toBe('<html>fake preview</html>');
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
