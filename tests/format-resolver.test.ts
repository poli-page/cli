import { describe, it, expect } from 'vitest';
import { resolveFormat } from '../src/format-resolver.js';

describe('resolveFormat', () => {
	it('should resolve A4 portrait', () => {
		const format = resolveFormat('A4', 'portrait');
		expect(format.name).toBe('A4');
		expect(format.orientation).toBe('portrait');
		expect(format.width).toBe(210);
		expect(format.height).toBe(297);
	});

	it('should resolve A4 landscape', () => {
		const format = resolveFormat('A4', 'landscape');
		expect(format.name).toBe('A4');
		expect(format.orientation).toBe('landscape');
		expect(format.width).toBe(297);
		expect(format.height).toBe(210);
	});

	it('should be case-insensitive for format', () => {
		const format = resolveFormat('a4', 'portrait');
		expect(format.name).toBe('A4');
	});

	it('should resolve Letter portrait', () => {
		const format = resolveFormat('Letter', 'portrait');
		expect(format.name).toBe('Letter');
	});

	it('should throw for unknown format', () => {
		expect(() => resolveFormat('A99', 'portrait')).toThrow(/Unknown page format/);
	});

	it('should throw for unknown orientation', () => {
		expect(() => resolveFormat('A4', 'diagonal')).toThrow(/Unknown orientation/);
	});
});
