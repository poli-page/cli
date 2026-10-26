import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuth } from '../src/auth.js';
import { writeCredentials, type StoredCredentials } from '../src/credentials.js';
import { testApiKey } from './helpers/api-key.js';

const baseCredentials: StoredCredentials = {
	session: 'session-token-abc',
	user: { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' },
	orgs: {},
};

describe('resolveAuth', () => {
	let fakeHome: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		fakeHome = await mkdtemp(join(tmpdir(), 'poli-auth-'));
		savedEnv = process.env.POLI_PAGE_API_KEY;
		delete process.env.POLI_PAGE_API_KEY;
	});

	afterEach(async () => {
		await rm(fakeHome, { recursive: true, force: true });
		if (savedEnv === undefined) {
			delete process.env.POLI_PAGE_API_KEY;
		} else {
			process.env.POLI_PAGE_API_KEY = savedEnv;
		}
	});

	describe('session mode (credentials present)', () => {
		it('returns session mode with X-Poli-Org-Id when manifest orgId is provided', async () => {
			await writeCredentials(baseCredentials, fakeHome);
			const ctx = await resolveAuth({
				manifestOrgId: 'org-123',
				homeDir: fakeHome,
			});
			expect(ctx).toEqual({
				mode: 'session',
				authorization: 'Bearer session-token-abc',
				orgIdHeader: 'org-123',
			});
		});

		it('throws a friendly error when manifest has no orgId', async () => {
			await writeCredentials(baseCredentials, fakeHome);
			await expect(resolveAuth({ homeDir: fakeHome })).rejects.toThrow(/isn't linked/i);
		});

		it('takes precedence over POLI_PAGE_API_KEY when both are set', async () => {
			await writeCredentials(baseCredentials, fakeHome);
			process.env.POLI_PAGE_API_KEY = testApiKey('sandbox');
			const ctx = await resolveAuth({
				manifestOrgId: 'org-123',
				homeDir: fakeHome,
			});
			expect(ctx.mode).toBe('session');
			expect(ctx.authorization).toBe('Bearer session-token-abc');
		});
	});

	describe('api-key mode (env var fallback)', () => {
		it('accepts a key and reads its environment from the prefix', async () => {
			process.env.POLI_PAGE_API_KEY = testApiKey('staging');
			const ctx = await resolveAuth({ homeDir: fakeHome });
			expect(ctx).toEqual({
				mode: 'api-key',
				authorization: `Bearer ${testApiKey('staging')}`,
				environment: 'staging',
			});
		});

		it('reads a hyphenated environment name', async () => {
			process.env.POLI_PAGE_API_KEY = testApiKey('staging-eu2');
			const ctx = await resolveAuth({ homeDir: fakeHome });
			expect(ctx.mode === 'api-key' && ctx.environment).toBe('staging-eu2');
		});

		it('accepts a 20-character environment name', async () => {
			process.env.POLI_PAGE_API_KEY = testApiKey('a'.repeat(20));
			const ctx = await resolveAuth({ homeDir: fakeHome });
			expect(ctx.mode === 'api-key' && ctx.environment).toBe('a'.repeat(20));
		});

		it('does not include orgIdHeader (key carries its org implicitly)', async () => {
			process.env.POLI_PAGE_API_KEY = testApiKey('sandbox');
			const ctx = await resolveAuth({
				manifestOrgId: 'org-from-manifest',
				homeDir: fakeHome,
			});
			expect(ctx.orgIdHeader).toBeUndefined();
		});

		it.each([
			['no pp_ prefix', 'not_a_valid_token'],
			['an old-style short key', 'pp_test_abc123'],
			['31 hex characters', 'pp_live_0123456789abcdef0123456789abcde'],
			['33 hex characters', 'pp_live_0123456789abcdef0123456789abcdef0'],
			['uppercase hex', 'pp_live_0123456789ABCDEF0123456789abcdef'],
			['no environment', 'pp__0123456789abcdef0123456789abcdef'],
			['an environment starting with a digit', testApiKey('1live')],
			['an uppercase environment', testApiKey('Live')],
			['a 21-character environment', testApiKey('a'.repeat(21))],
			['a double hyphen', testApiKey('stag--ing')],
			['a trailing hyphen', testApiKey('staging-')],
			['a third segment', 'pp_sa_live_0123456789abcdef0123456789abcdef'],
		])('rejects %s, showing the pp_<environment>_ format', async (_label, key) => {
			process.env.POLI_PAGE_API_KEY = key;
			await expect(resolveAuth({ homeDir: fakeHome })).rejects.toThrow(
				/POLI_PAGE_API_KEY.*`pp_<environment>_/
			);
		});

		it('treats an empty env var like an unset one (falls through to error)', async () => {
			process.env.POLI_PAGE_API_KEY = '';
			await expect(resolveAuth({ homeDir: fakeHome })).rejects.toThrow(/Not logged in/);
		});
	});

	describe('no auth available', () => {
		it('throws a friendly error when neither credentials nor env var are set', async () => {
			await expect(resolveAuth({ homeDir: fakeHome })).rejects.toThrow(
				/Not logged in.*poli login.*POLI_PAGE_API_KEY/
			);
		});
	});
});
