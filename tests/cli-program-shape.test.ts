/**
 * Structural regression tests for the Commander program.
 *
 * Background: the global `--version` flag (set via `program.version()`)
 * shadowed a per-subcommand `--version` flag on `render`, causing
 * `poli render --version 1.2.3` to print the CLI version instead of
 * rendering. Fix: drop `--version` from the subcommand and switch to
 * `poli render <name>@<version>` (npm-style spec).
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

describe('cli program shape — publish', () => {
	const cmd = findCommand('publish');

	it('takes no positional argument', () => {
		const args = (cmd as unknown as { registeredArguments: unknown[] }).registeredArguments;
		expect(args).toHaveLength(0);
	});

	it('exposes --env / -m, --message / -y, --yes / --json', () => {
		const flags = cmd.options.map((o) => o.flags);
		expect(flags).toEqual(
			expect.arrayContaining(['--env <name>', '-m, --message <text>', '-y, --yes', '--json'])
		);
	});
});

describe('cli program shape — render', () => {
	const cmd = findCommand('render');

	it('takes a single required positional argument (template spec)', () => {
		const args = (
			cmd as unknown as { registeredArguments: { name(): string; required: boolean }[] }
		).registeredArguments;
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

// Publishing to an environment replaced the version workflow, and the
// authenticated HTML preview is gone from the API: none of these commands
// exist, and neither do the client calls they used.
describe('cli program shape — no versions, push or preview', () => {
	const removed = ['push', 'promote', 'unpromote', 'versions', 'preview', 'checkout'];

	it.each(removed)('has no `%s` command', (name) => {
		const names = createProgram().commands.map((c) => c.name());
		expect(names).not.toContain(name);
	});

	it('`poli --help` lists none of them', () => {
		const help = createProgram().helpInformation();
		for (const name of removed) {
			expect(help).not.toMatch(new RegExp(`^ {2}${name}\\b`, 'm'));
		}
	});

	it('keeps `poli documents preview`', () => {
		const names = findCommand('documents').commands.map((c) => c.name());
		expect(names).toContain('preview');
	});

	it.each([
		'downloadVersion',
		'pushVersion',
		'listVersions',
		'promoteVersion',
		'unpromoteVersion',
		'unpromotePreview',
		'deprecateVersion',
		'undeprecateVersion',
		'updateProject',
		'renderPreview',
	])('the API client has no `%s` call', (method) => {
		expect(createApiClient()).not.toHaveProperty(method);
	});
});

describe('cli program shape — init', () => {
	const cmd = findCommand('init');

	it('takes an optional positional (project name, or the starter directory)', () => {
		const args = (
			cmd as unknown as { registeredArguments: { name(): string; required: boolean }[] }
		).registeredArguments;
		expect(args).toHaveLength(1);
		expect(args[0].required).toBe(false);
	});

	it('exposes --starter, --org and --force for the starter project', () => {
		const longs = cmd.options.map((o) => o.long);
		expect(longs).toEqual(expect.arrayContaining(['--starter', '--org', '--force']));
		expect(cmd.helpInformation()).toContain('getting-started');
	});
});
