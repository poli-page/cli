import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	readCredentials,
	writeCredentials,
	clearCredentials,
	updateOrgKeys,
	getSessionToken,
	getApiKey,
	type StoredCredentials,
} from '../src/credentials.js';
import { CREDENTIALS_DIR, CREDENTIALS_FILENAME } from '../src/constants.js';

describe('credentials', () => {
	let fakeHome: string;

	const mockCredentials: StoredCredentials = {
		session: 'test-session-token',
		user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
		orgs: {
			'acme-corp': {
				testKey: 'pp_test_abc123',
				liveKey: 'pp_live_xyz789',
			},
		},
	};

	beforeEach(async () => {
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-creds-'));
	});

	afterEach(async () => {
		await rm(fakeHome, { recursive: true, force: true });
	});

	describe('writeCredentials / readCredentials', () => {
		it('should write and read credentials', async () => {
			await writeCredentials(mockCredentials, fakeHome);
			const read = await readCredentials(fakeHome);
			expect(read).toEqual(mockCredentials);
		});

		it('should create the .polipage directory if needed', async () => {
			await writeCredentials(mockCredentials, fakeHome);
			const dir = join(fakeHome, CREDENTIALS_DIR);
			const stats = await stat(dir);
			expect(stats.isDirectory()).toBe(true);
		});

		it('should return null if no credentials file', async () => {
			const result = await readCredentials(fakeHome);
			expect(result).toBeNull();
		});
	});

	describe('clearCredentials', () => {
		it('should remove the credentials file', async () => {
			await writeCredentials(mockCredentials, fakeHome);
			await clearCredentials(fakeHome);
			const result = await readCredentials(fakeHome);
			expect(result).toBeNull();
		});

		it('should not throw if no credentials file', async () => {
			await expect(clearCredentials(fakeHome)).resolves.not.toThrow();
		});
	});

	describe('updateOrgKeys', () => {
		it('should add keys for a new org', async () => {
			await writeCredentials(mockCredentials, fakeHome);
			await updateOrgKeys('new-org', { testKey: 'pp_test_new' }, fakeHome);
			const creds = await readCredentials(fakeHome);
			expect(creds?.orgs['new-org']?.testKey).toBe('pp_test_new');
		});

		it('should merge keys into existing org', async () => {
			await writeCredentials(mockCredentials, fakeHome);
			await updateOrgKeys('acme-corp', { testKey: 'pp_test_updated' }, fakeHome);
			const creds = await readCredentials(fakeHome);
			expect(creds?.orgs['acme-corp']?.testKey).toBe('pp_test_updated');
			expect(creds?.orgs['acme-corp']?.liveKey).toBe('pp_live_xyz789');
		});

		it('should throw if not logged in', async () => {
			await expect(
				updateOrgKeys('org', { testKey: 'key' }, fakeHome)
			).rejects.toThrow(/Not logged in/);
		});
	});

	describe('getSessionToken', () => {
		it('should return the session token', async () => {
			await writeCredentials(mockCredentials, fakeHome);
			const token = await getSessionToken(fakeHome);
			expect(token).toBe('test-session-token');
		});

		it('should throw if not logged in', async () => {
			await expect(getSessionToken(fakeHome)).rejects.toThrow(/Not logged in/);
		});
	});

	describe('getApiKey', () => {
		it('should return the test key', async () => {
			await writeCredentials(mockCredentials, fakeHome);
			const key = await getApiKey('acme-corp', 'test', fakeHome);
			expect(key).toBe('pp_test_abc123');
		});

		it('should return the live key', async () => {
			await writeCredentials(mockCredentials, fakeHome);
			const key = await getApiKey('acme-corp', 'live', fakeHome);
			expect(key).toBe('pp_live_xyz789');
		});

		it('should throw if org not found', async () => {
			await writeCredentials(mockCredentials, fakeHome);
			await expect(getApiKey('unknown-org', 'test', fakeHome)).rejects.toThrow(
				/No credentials/
			);
		});

		it('should throw if not logged in', async () => {
			await expect(getApiKey('acme-corp', 'test', fakeHome)).rejects.toThrow(
				/Not logged in/
			);
		});
	});
});
