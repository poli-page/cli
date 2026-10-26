import type { ApiClient } from '../../src/api-client.js';

/**
 * A fake `ApiClient` that answers only with `overrides`: any other method
 * rejects with `unexpected API call: <name>`, so a test fails on a call it
 * did not stub instead of reading a silent default.
 */
export function createFakeApiClient(overrides: Partial<ApiClient>): ApiClient {
	return new Proxy(overrides, {
		get(target, prop) {
			const value = Reflect.get(target, prop);
			if (value !== undefined) return value;
			return async () => {
				throw new Error(`unexpected API call: ${String(prop)}`);
			};
		},
	}) as ApiClient;
}
