import { describe, it, expect, vi, afterEach } from 'vitest';
import type { StoredCredentials } from '../../src/credentials.js';
import { createFakeApiClient } from '../helpers/fake-api-client.js';

const readCredentials = vi.fn<() => Promise<StoredCredentials | null>>();

vi.mock('../../src/credentials.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../src/credentials.js')>()),
	readCredentials: () => readCredentials(),
}));

const { executeWhoami } = await import('../../src/commands/auth.js');

const user = { id: 'user_1', name: 'Xavier', email: 'xavier@test.com' };

describe('poli whoami, session without a linked project', () => {
	afterEach(() => {
		readCredentials.mockReset();
	});

	it('does not send a session another origin issued when the credentials change between reads', async () => {
		// resolveAuth reads a default-origin session; a concurrent login then
		// replaces it with one from another API before the fallback rereads it.
		readCredentials
			.mockResolvedValueOnce({ session: 'default-session', user, orgs: {} })
			.mockResolvedValueOnce({
				session: 'staging-session',
				origin: 'https://staging.poli.page',
				user,
				orgs: {},
			});
		const getOrganizations = vi.fn(async () => []);

		await expect(
			executeWhoami({ cwd: '/nonexistent', apiClient: createFakeApiClient({ getOrganizations }) })
		).rejects.toThrow(/Not logged in/);
		expect(getOrganizations).not.toHaveBeenCalled();
	});
});
