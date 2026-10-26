import { describe, it, expect } from 'vitest';
import { createFakeApiClient } from './fake-api-client.js';

describe('createFakeApiClient', () => {
	it('answers with the overridden methods', async () => {
		const client = createFakeApiClient({ listProjects: async () => [] });

		await expect(client.listProjects('sess', 'org_1')).resolves.toEqual([]);
	});

	it('fails a call to a method that was not overridden, naming it', async () => {
		const client = createFakeApiClient({ listProjects: async () => [] });

		await expect(client.getMe('Bearer x')).rejects.toThrow('unexpected API call: getMe');
	});
});
