import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCredentials, type StoredCredentials } from '../src/credentials.js';
import { CREDENTIALS_DIR, CREDENTIALS_FILENAME } from '../src/constants.js';

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return { ...actual, chmod: vi.fn(actual.chmod) };
});

describe('writeCredentials when the file cannot be tightened', () => {
	let fakeHome: string;

	const mockCredentials: StoredCredentials = {
		session: 'test-session-token',
		user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
		orgs: {},
	};

	beforeEach(async () => {
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-test-'));
	});

	afterEach(async () => {
		vi.mocked(fsPromises.chmod).mockReset();
		await rm(fakeHome, { recursive: true, force: true });
	});

	it('should not write the secrets into an existing file it could not chmod', async () => {
		const dir = join(fakeHome, CREDENTIALS_DIR);
		const path = join(dir, CREDENTIALS_FILENAME);
		await mkdir(dir, { mode: 0o700 });
		await writeFile(path, '{}\n', { mode: 0o644 });
		vi.mocked(fsPromises.chmod).mockImplementation(async (target) => {
			if (target === path) {
				throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
			}
		});

		await expect(writeCredentials(mockCredentials, fakeHome)).rejects.toThrow(/EPERM/);
		expect(await readFile(path, 'utf-8')).toBe('{}\n');
	});
});
