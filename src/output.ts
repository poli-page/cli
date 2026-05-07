export interface OutputOptions {
	json?: boolean;
}

export interface OutputContext {
	isTTY?: boolean;
}

/**
 * Decide whether a command should emit machine-readable JSON instead of
 * the human-friendly summary. Rule (matches `gh`, `kubectl`, `jq`):
 *
 *   1. `--json` flag explicit → JSON, always.
 *   2. `stdout` is **not** a TTY (pipe, redirect, CI) → JSON.
 *   3. `stdout` is a TTY → human summary.
 *
 * Callers can override the TTY detection via `OutputContext.isTTY` —
 * useful for tests and for commands that emit to streams other than
 * `process.stdout`.
 */
export function shouldEmitJson(
	options: OutputOptions = {},
	context: OutputContext = {}
): boolean {
	if (options.json === true) {
		return true;
	}
	const isTTY =
		context.isTTY !== undefined ? context.isTTY : Boolean(process.stdout.isTTY);
	return !isTTY;
}
