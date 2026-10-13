/**
 * Structural regression tests for the Commander program.
 *
 * Background: the global `--version` flag (set via `program.version()`)
 * shadowed the per-subcommand `--version` flag on `push` and `render`,
 * causing `poli push --version 1.2.3` to print the CLI version instead
 * of pushing. Fix: drop `--version` from both subcommands and switch to
 *   - `poli push <version>` (positional)
 *   - `poli render <name>@<version>` (npm-style spec)
 *
 * These tests pin the new shape so the bug cannot silently come back.
 */

import { describe, it, expect } from 'vitest';
import { createProgram } from '../src/program.js';
import { createApiClient } from '../src/api-client.js';

function findCommand(name: string) {
	const program = createProgram();
	const cmd = program.commands.find((c) => c.name() === name);
	if (!cmd) throw new Error(`Command "${name}" not found`);
	return cmd;
}

describe('cli program shape — push', () => {
	const cmd = findCommand('push');

	it('exposes a single optional positional argument named "version"', () => {
		const args = (cmd as unknown as { registeredArguments: { name(): string; required: boolean }[] })
			.registeredArguments;
		expect(args).toHaveLength(1);
		expect(args[0].name()).toBe('version');
		expect(args[0].required).toBe(false);
	});

	it('does not expose a --version option (would clash with the global one)', () => {
		const versionOpt = cmd.options.find((o) => o.long === '--version');
		expect(versionOpt).toBeUndefined();
	});

	it('still exposes --patch / --minor / --major / --track / -m / --json', () => {
		const longs = cmd.options.map((o) => o.long);
		expect(longs).toEqual(
			expect.arrayContaining(['--patch', '--minor', '--major', '--track', '--message', '--json'])
		);
	});
});

describe('cli program shape — render', () => {
	const cmd = findCommand('render');

	it('takes a single required positional argument (template spec)', () => {
		const args = (cmd as unknown as { registeredArguments: { name(): string; required: boolean }[] })
			.registeredArguments;
		expect(args).toHaveLength(1);
		expect(args[0].required).toBe(true);
	});

	it('does not expose a --version option (would clash with the global one)', () => {
		const versionOpt = cmd.options.find((o) => o.long === '--version');
		expect(versionOpt).toBeUndefined();
	});

	it('still exposes -o / -d / --no-download / --json', () => {
		const longs = cmd.options.map((o) => o.long);
		expect(longs).toEqual(
			expect.arrayContaining(['--output', '--data', '--no-download', '--json'])
		);
	});
});

// The API no longer serves project or version bundles (no pull, no
// checkout: the local project is the source of truth). The commands that
// downloaded them are gone, and so is the client call they used.
describe('cli program shape — no bundle download (pull / checkout)', () => {
	it('has no `checkout` command', () => {
		const names = createProgram().commands.map((c) => c.name());
		expect(names).not.toContain('checkout');
	});

	it('has no `versions download` subcommand', () => {
		const versions = findCommand('versions');
		const names = versions.commands.map((c) => c.name());
		expect(names).not.toContain('download');
	});

	it('the API client has no bundle download call', () => {
		expect(createApiClient()).not.toHaveProperty('downloadVersion');
	});
});
