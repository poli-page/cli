import { vi } from 'vitest';

/**
 * Points the user's home directory at `home` for the current test:
 * `os.homedir()` reads `HOME` on POSIX and `USERPROFILE` on Windows.
 * Undone by `vi.unstubAllEnvs()`.
 */
export function stubHome(home: string): void {
	vi.stubEnv('HOME', home);
	vi.stubEnv('USERPROFILE', home);
}
