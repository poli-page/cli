import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDocumentsThumbnails } from '../../../src/commands/documents/thumbnails.js';
import {
	ThumbnailsNotAvailableError,
	DocumentNotFoundError,
	type ThumbnailResult as ApiThumbnailResult,
} from '../../../src/api-client.js';
import { createFakeApiClient } from '../../helpers/fake-api-client.js';
import { testApiKey } from '../../helpers/api-key.js';

const TINY_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
	'Nl7BcQAAAABJRU5ErkJggg==';

function fakeThumb(page: number, contentType = 'image/png'): ApiThumbnailResult {
	return {
		page,
		width: 400,
		height: 566,
		contentType,
		data: TINY_PNG_BASE64,
	};
}

describe('executeDocumentsThumbnails', () => {
	let tempDir: string;
	let fakeHome: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'poli-docs-thumb-'));
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-docs-thumb-home-'));
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

	it('writes PNG files to ./output/thumbnails/<id>/page-N.png by default', async () => {
		const client = createFakeApiClient({
			documentThumbnails: async () => [fakeThumb(1), fakeThumb(2)],
		});

		const results = await executeDocumentsThumbnails('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
		});

		expect(results).toHaveLength(2);
		expect(results[0].path).toBe(
			join(tempDir, 'output', 'thumbnails', 'doc_abc', 'page-1.png')
		);
		expect(results[1].path).toBe(
			join(tempDir, 'output', 'thumbnails', 'doc_abc', 'page-2.png')
		);
		const s = await stat(results[0].path);
		expect(s.isFile()).toBe(true);
		expect(s.size).toBeGreaterThan(0);
	});

	it('refuses a symlink planted at a default path and leaves its target untouched', async () => {
		const victim = join(fakeHome, 'victim');
		await writeFile(victim, 'original');
		const dir = join(tempDir, 'output', 'thumbnails', 'doc_abc');
		await mkdir(dir, { recursive: true });
		await symlink(victim, join(dir, 'page-1.png'));
		const client = createFakeApiClient({ documentThumbnails: async () => [fakeThumb(1)] });

		await expect(
			executeDocumentsThumbnails('doc_abc', {
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: client,
			})
		).rejects.toThrow(/Refusing/);
		expect(await readFile(victim, 'utf-8')).toBe('original');
	});

	it('refuses a symlinked output folder that leaves the working directory before any request', async () => {
		await symlink(fakeHome, join(tempDir, 'output'));
		const documentThumbnails = vi.fn(async () => [fakeThumb(1)]);
		const client = createFakeApiClient({ documentThumbnails });

		await expect(
			executeDocumentsThumbnails('doc_abc', {
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: client,
			})
		).rejects.toThrow(/Refusing/);
		expect(await readdir(fakeHome)).toEqual([]);
		expect(documentThumbnails).not.toHaveBeenCalled();
	});

	it.each([0, -1, 1.5, Number.NaN, '1/../../x'])(
		'refuses a thumbnail whose page is %s and writes nothing',
		async (page) => {
			const client = createFakeApiClient({
				documentThumbnails: async () => [fakeThumb(1), fakeThumb(page as number)],
			});

			await expect(
				executeDocumentsThumbnails('doc_abc', {
					cwd: tempDir,
					homeDir: fakeHome,
					apiClient: client,
				})
			).rejects.toThrow(/invalid page/);
			expect(await readdir(tempDir)).toEqual([]);
		}
	);

	it.each(['../../x', 'a/b', 'a\\b', '..', 'doc..x'])(
		'refuses the id %s before any request and writes nothing',
		async (id) => {
			const documentThumbnails = vi.fn();
			await expect(
				executeDocumentsThumbnails(id, {
					cwd: tempDir,
					homeDir: fakeHome,
					apiClient: createFakeApiClient({ documentThumbnails }),
				})
			).rejects.toThrow(/Invalid document ID/);
			expect(documentThumbnails).not.toHaveBeenCalled();
			expect(await readdir(tempDir)).toEqual([]);
		}
	);

	it('writes JPEG when format=jpeg and uses .jpeg extension', async () => {
		const client = createFakeApiClient({
			documentThumbnails: async () => [fakeThumb(1, 'image/jpeg')],
		});

		const results = await executeDocumentsThumbnails('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
			format: 'jpeg',
		});

		expect(results[0].path).toMatch(/page-1\.jpeg$/);
	});

	it('forwards width / quality / pages to the API', async () => {
		let captured: Record<string, unknown> = {};
		const client = createFakeApiClient({
			documentThumbnails: async (_a, _o, _id, opts) => {
				captured = opts as unknown as Record<string, unknown>;
				return [fakeThumb(1), fakeThumb(3)];
			},
		});

		await executeDocumentsThumbnails('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
			width: 800,
			quality: 90,
			format: 'jpeg',
			pages: [1, 3],
		});

		expect(captured).toEqual({
			width: 800,
			quality: 90,
			format: 'jpeg',
			pages: [1, 3],
		});
	});

	it('writes to custom output directory via -o', async () => {
		const customDir = join(tempDir, 'out-thumbs');
		const client = createFakeApiClient({
			documentThumbnails: async () => [fakeThumb(1)],
		});

		const results = await executeDocumentsThumbnails('doc_abc', {
			cwd: tempDir,
			homeDir: fakeHome,
			apiClient: client,
			output: customDir,
		});

		expect(results[0].path).toBe(join(customDir, 'page-1.png'));
	});

	it('propagates ThumbnailsNotAvailableError (free tier)', async () => {
		const client = createFakeApiClient({
			documentThumbnails: async () => {
				throw new ThumbnailsNotAvailableError('Thumbnails require a paid plan.');
			},
		});

		await expect(
			executeDocumentsThumbnails('doc_abc', {
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: client,
			})
		).rejects.toBeInstanceOf(ThumbnailsNotAvailableError);
	});

	it('propagates DocumentNotFoundError', async () => {
		const client = createFakeApiClient({
			documentThumbnails: async () => {
				throw new DocumentNotFoundError('not found');
			},
		});

		await expect(
			executeDocumentsThumbnails('doc_missing', {
				cwd: tempDir,
				homeDir: fakeHome,
				apiClient: client,
			})
		).rejects.toBeInstanceOf(DocumentNotFoundError);
	});
});
