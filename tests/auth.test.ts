import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuth } from '../src/auth.js';
import { writeCredentials, type StoredCredentials } from '../src/credentials.js';

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
			await expect(resolveAuth({ homeDir: fakeHome })).rejects.toThrow(
				/isn't linked/i
			);
		});

		it('takes precedence over POLI_PAGE_API_KEY when both are set', async () => {
			await writeCredentials(baseCredentials, fakeHome);
			process.env.POLI_PAGE_API_KEY = 'pp_test_should_be_ignored';
			const ctx = await resolveAuth({
				manifestOrgId: 'org-123',
				homeDir: fakeHome,
			});
			expect(ctx.mode).toBe('session');
			expect(ctx.authorization).toBe('Bearer session-token-abc');
		});
	});

	describe('api-key mode (env var fallback)', () => {
		it('accepts pp_test_* keys', async () => {
			process.env.POLI_PAGE_API_KEY = 'pp_test_abc123';
			const ctx = await resolveAuth({ homeDir: fakeHome });
			expect(ctx).toEqual({
				mode: 'api-key',
				authorization: 'Bearer pp_test_abc123',
			});
		});

		it('accepts pp_live_* keys', async () => {
			process.env.POLI_PAGE_API_KEY = 'pp_live_xyz789';
			const ctx = await resolveAuth({ homeDir: fakeHome });
			expect(ctx.mode).toBe('api-key');
			expect(ctx.authorization).toBe('Bearer pp_live_xyz789');
		});

		it('accepts pp_sa_* (service account) keys', async () => {
			process.env.POLI_PAGE_API_KEY = 'pp_sa_ci_token_456';
			const ctx = await resolveAuth({ homeDir: fakeHome });
			expect(ctx.mode).toBe('api-key');
			expect(ctx.authorization).toBe('Bearer pp_sa_ci_token_456');
		});

		it('does not include orgIdHeader (key carries its org implicitly)', async () => {
			process.env.POLI_PAGE_API_KEY = 'pp_test_abc123';
			const ctx = await resolveAuth({
				manifestOrgId: 'org-from-manifest',
				homeDir: fakeHome,
			});
			expect(ctx.orgIdHeader).toBeUndefined();
		});

		it('rejects an env var value that does not start with pp_', async () => {
			process.env.POLI_PAGE_API_KEY = 'not_a_valid_token';
			await expect(resolveAuth({ homeDir: fakeHome })).rejects.toThrow(
				/POLI_PAGE_API_KEY.*pp_/
			);
		});

		it('treats an empty env var like an unset one (falls through to error)', async () => {
			process.env.POLI_PAGE_API_KEY = '';
			await expect(resolveAuth({ homeDir: fakeHome })).rejects.toThrow(
				/Not logged in/
			);
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
