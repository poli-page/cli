import { describe, it, expect, afterEach } from 'vitest';
import { shouldEmitJson } from '../src/output.js';

describe('shouldEmitJson', () => {
	const originalIsTTY = process.stdout.isTTY;

	afterEach(() => {
		// Restore the real flag — other tests may rely on it.
		Object.defineProperty(process.stdout, 'isTTY', {
			configurable: true,
			value: originalIsTTY,
		});
	});

	function setStdoutTTY(value: boolean): void {
		Object.defineProperty(process.stdout, 'isTTY', {
			configurable: true,
			value,
		});
	}

	it('returns true when --json is set, even in TTY', () => {
		setStdoutTTY(true);
		expect(shouldEmitJson({ json: true })).toBe(true);
	});

	it('returns true when stdout is piped (not TTY) without --json', () => {
		setStdoutTTY(false);
		expect(shouldEmitJson({})).toBe(true);
	});

	it('returns false in TTY without --json (human-friendly default)', () => {
		setStdoutTTY(true);
		expect(shouldEmitJson({})).toBe(false);
	});

	it('returns true with --json regardless of TTY', () => {
		setStdoutTTY(false);
		expect(shouldEmitJson({ json: true })).toBe(true);
	});

	it('treats undefined `json` like false (TTY-only default)', () => {
		setStdoutTTY(true);
		expect(shouldEmitJson({ json: undefined })).toBe(false);
	});

	it('accepts an explicit isTTY override (for tests / non-stdout streams)', () => {
		setStdoutTTY(true);
		expect(shouldEmitJson({}, { isTTY: false })).toBe(true);
		expect(shouldEmitJson({ json: true }, { isTTY: false })).toBe(true);
		expect(shouldEmitJson({}, { isTTY: true })).toBe(false);
	});
});
