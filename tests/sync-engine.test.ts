import { describe, it, expect, vi } from 'vitest';
import { computeDelta, hashContent, syncWithRetry } from '../src/sync-engine.js';
import {
	OrgMigratingError,
	NotAMemberError,
	SystemProjectLockedError,
	type PatchFilesResult,
} from '../src/api-client.js';

describe('hashContent', () => {
	it('returns a hex sha256 digest of the content', () => {
		const a = hashContent('hello');
		const b = hashContent('hello');
		const c = hashContent('hello!');
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it('hashes binary content via Buffer input', () => {
		const buf = Buffer.from([0xff, 0xd8, 0xff]);
		expect(hashContent(buf)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('computeDelta', () => {
	it('on first run (empty oldHashes), all files are added', () => {
		const oldHashes = new Map<string, string>();
		const newFiles = new Map<string, string>([
			['templates/inv.html', '<h1>invoice</h1>'],
			['templates/inv.json', '{"foo": 1}'],
		]);

		const delta = computeDelta(oldHashes, newFiles);

		expect(delta.added).toHaveLength(2);
		expect(delta.modified).toHaveLength(0);
		expect(delta.deleted).toHaveLength(0);
		expect(delta.added.map((e) => e.path).sort()).toEqual([
			'templates/inv.html',
			'templates/inv.json',
		]);
		expect(delta.newHashes.size).toBe(2);
	});

	it('classifies a content change as `modified`, not `added`', () => {
		const oldHashes = new Map([
			['templates/inv.html', hashContent('<h1>old</h1>')],
		]);
		const newFiles = new Map([['templates/inv.html', '<h1>new</h1>']]);

		const delta = computeDelta(oldHashes, newFiles);

		expect(delta.added).toHaveLength(0);
		expect(delta.modified).toEqual([
			{ path: 'templates/inv.html', content: '<h1>new</h1>' },
		]);
		expect(delta.deleted).toHaveLength(0);
	});

	it('classifies a missing file as `deleted`', () => {
		const oldHashes = new Map([
			['templates/old.html', hashContent('<h1>old</h1>')],
		]);
		const newFiles = new Map<string, string>();

		const delta = computeDelta(oldHashes, newFiles);

		expect(delta.deleted).toEqual(['templates/old.html']);
		expect(delta.newHashes.size).toBe(0);
	});

	it('omits unchanged files from all three lists', () => {
		const content = '<h1>same</h1>';
		const oldHashes = new Map([['templates/inv.html', hashContent(content)]]);
		const newFiles = new Map([['templates/inv.html', content]]);

		const delta = computeDelta(oldHashes, newFiles);

		expect(delta.added).toHaveLength(0);
		expect(delta.modified).toHaveLength(0);
		expect(delta.deleted).toHaveLength(0);
		expect(delta.newHashes.get('templates/inv.html')).toBe(hashContent(content));
	});

	it('handles a mixed delta (added + modified + deleted + unchanged)', () => {
		const oldHashes = new Map([
			['kept.html', hashContent('same')],
			['changed.html', hashContent('old')],
			['removed.html', hashContent('gone')],
		]);
		const newFiles = new Map([
			['kept.html', 'same'],
			['changed.html', 'new'],
			['brand-new.html', 'fresh'],
		]);

		const delta = computeDelta(oldHashes, newFiles);

		expect(delta.added.map((e) => e.path)).toEqual(['brand-new.html']);
		expect(delta.modified.map((e) => e.path)).toEqual(['changed.html']);
		expect(delta.deleted).toEqual(['removed.html']);
		expect(delta.newHashes.size).toBe(3);
		expect(delta.newHashes.has('removed.html')).toBe(false);
		expect(delta.newHashes.has('brand-new.html')).toBe(true);
	});

	it('returns a fresh newHashes map (does not mutate oldHashes)', () => {
		const oldHashes = new Map([['x', hashContent('a')]]);
		const newFiles = new Map([['x', 'b']]);

		const delta = computeDelta(oldHashes, newFiles);

		expect(oldHashes.get('x')).toBe(hashContent('a'));
		expect(delta.newHashes.get('x')).toBe(hashContent('b'));
		expect(delta.newHashes).not.toBe(oldHashes);
	});
});

describe('syncWithRetry', () => {
	const fakeResult: PatchFilesResult = { syncedAt: '2026-05-06T10:00:00.000Z' };

	it('returns immediately on success without sleeping', async () => {
		const sleepFn = vi.fn().mockResolvedValue(undefined);
		const syncFn = vi.fn().mockResolvedValue(fakeResult);

		const result = await syncWithRetry({ syncFn, sleepFn });

		expect(result).toEqual(fakeResult);
		expect(syncFn).toHaveBeenCalledTimes(1);
		expect(sleepFn).not.toHaveBeenCalled();
	});

	it('retries network errors with exponential backoff (1s, 2s, 4s, …) capped at 30s', async () => {
		const sleepFn = vi.fn().mockResolvedValue(undefined);
		const syncFn = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('fetch failed'))
			.mockRejectedValueOnce(new TypeError('fetch failed'))
			.mockRejectedValueOnce(new TypeError('fetch failed'))
			.mockResolvedValue(fakeResult);

		const result = await syncWithRetry({ syncFn, sleepFn });

		expect(result).toEqual(fakeResult);
		expect(syncFn).toHaveBeenCalledTimes(4);
		expect(sleepFn.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000]);
	});

	it('caps the backoff at 30s after enough retries', async () => {
		const sleepFn = vi.fn().mockResolvedValue(undefined);
		// 1, 2, 4, 8, 16, 30, 30 → 7 sleeps before success on 8th attempt
		const failures = Array.from({ length: 7 }, () => new TypeError('fetch failed'));
		const syncFn = vi.fn();
		for (const err of failures) {
			syncFn.mockRejectedValueOnce(err);
		}
		syncFn.mockResolvedValue(fakeResult);

		await syncWithRetry({ syncFn, sleepFn });

		expect(sleepFn.mock.calls.map((c) => c[0])).toEqual([
			1000, 2000, 4000, 8000, 16000, 30000, 30000,
		]);
	});

	it('handles ORGANIZATION_MIGRATING by sleeping 5s and retrying', async () => {
		const sleepFn = vi.fn().mockResolvedValue(undefined);
		const syncFn = vi
			.fn()
			.mockRejectedValueOnce(new OrgMigratingError('migrating'))
			.mockResolvedValue(fakeResult);

		const result = await syncWithRetry({ syncFn, sleepFn });

		expect(result).toEqual(fakeResult);
		expect(syncFn).toHaveBeenCalledTimes(2);
		expect(sleepFn).toHaveBeenCalledWith(5000);
	});

	it('throws immediately on non-retryable ApiError (e.g. NOT_A_MEMBER)', async () => {
		const sleepFn = vi.fn();
		const syncFn = vi.fn().mockRejectedValue(new NotAMemberError('not a member'));

		await expect(syncWithRetry({ syncFn, sleepFn })).rejects.toBeInstanceOf(
			NotAMemberError
		);
		expect(syncFn).toHaveBeenCalledTimes(1);
		expect(sleepFn).not.toHaveBeenCalled();
	});

	it('throws immediately on SYSTEM_PROJECT_LOCKED (non-retryable)', async () => {
		const sleepFn = vi.fn();
		const syncFn = vi
			.fn()
			.mockRejectedValue(new SystemProjectLockedError('system project'));

		await expect(syncWithRetry({ syncFn, sleepFn })).rejects.toBeInstanceOf(
			SystemProjectLockedError
		);
		expect(syncFn).toHaveBeenCalledTimes(1);
		expect(sleepFn).not.toHaveBeenCalled();
	});

	it('respects an abort signal between retries', async () => {
		const sleepFn = vi.fn().mockResolvedValue(undefined);
		const controller = new AbortController();
		const syncFn = vi.fn().mockImplementation(async () => {
			controller.abort();
			throw new TypeError('fetch failed');
		});

		await expect(
			syncWithRetry({ syncFn, sleepFn, signal: controller.signal })
		).rejects.toThrow(/abort/i);
		expect(syncFn).toHaveBeenCalledTimes(1);
	});
});
