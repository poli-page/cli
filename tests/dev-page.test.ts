import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
	DEV_ERROR_TITLES,
	DEV_PAGE_HTML,
	DEV_PAGE_SECURITY_HEADERS,
	DEV_PLACEHOLDER_HTML,
	DEV_PLACEHOLDER_SECURITY_HEADERS,
} from '../src/dev-page.js';
import type { DevError } from '../src/commands/dev.js';

describe('dev page template', () => {
	it('gives the template <select> an accessible name via a visually-hidden label', () => {
		// `hidden` (or a class that is never defined) removes the label
		// from the accessibility tree, leaving only the inconsistently
		// announced `title` attribute.
		expect(DEV_PAGE_HTML).toContain(
			'<label class="visually-hidden" for="template">Template</label>'
		);
		expect(DEV_PAGE_HTML).not.toMatch(/<label[^>]*\shidden[\s>]/);
		// The class the label relies on must actually exist in the page CSS.
		expect(DEV_PAGE_HTML).toContain('.visually-hidden {');
	});

	it('titles the error overlay accurately for every failure stage', () => {
		const stages: Array<DevError['stage']> = ['sync', 'render', 'project'];
		const titles = stages.map((stage) => DEV_ERROR_TITLES[stage]);

		// Every stage has its own non-empty, distinct title — no stage
		// falls back to another stage's wording.
		expect(titles.every((title) => title.length > 0)).toBe(true);
		expect(new Set(titles).size).toBe(stages.length);
		expect(DEV_ERROR_TITLES.sync).toBe('Sync failed');
		expect(DEV_ERROR_TITLES.render).toBe('Render failed');
		expect(DEV_ERROR_TITLES.project).toMatch(/project/i);

		// The page embeds the table verbatim, so the browser shows exactly
		// these titles.
		expect(DEV_PAGE_HTML).toContain(JSON.stringify(DEV_ERROR_TITLES));
	});

	it('shows the draft PDF in the frame and has no separate PDF or live-preview mode', () => {
		expect(DEV_PAGE_HTML).toContain('<iframe id="frame" src="/pdf"');
		expect(DEV_PAGE_HTML).toContain("frame.src = '/pdf?v=' + version;");
		expect(DEV_PAGE_HTML).not.toContain('Render PDF');
		expect(DEV_PAGE_HTML).not.toContain('Live preview');
		expect(DEV_PAGE_HTML).not.toContain('/api/pdf');
		expect(DEV_PAGE_HTML).not.toContain('pageCount');
	});

	it('allows its inline script and style by hash, and has no inline code the CSP would block', () => {
		const hash = (source: string) =>
			`'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;
		const cases = [
			[DEV_PAGE_HTML, DEV_PAGE_SECURITY_HEADERS],
			[DEV_PLACEHOLDER_HTML, DEV_PLACEHOLDER_SECURITY_HEADERS],
		] as const;
		for (const [html, headers] of cases) {
			const csp = headers['Content-Security-Policy'];
			expect(csp).not.toContain('unsafe-inline');
			const scripts = html.split('<script>').slice(1).map((part) => part.split('</script>')[0]);
			const styles = html.split('<style>').slice(1).map((part) => part.split('</style>')[0]);
			// Every element is a bare <script>/<style>, so each one is hashed.
			expect(html.split('<script').length - 1).toBe(scripts.length);
			expect(html.split('<style').length - 1).toBe(styles.length);
			for (const source of scripts) expect(csp).toContain(hash(source));
			for (const source of styles) expect(csp).toContain(hash(source));
			// Attributes CSP blocks without 'unsafe-inline'.
			expect(html).not.toMatch(/\s(on[a-z]+|style)=/);
		}
		expect(DEV_PAGE_HTML).toContain('<script>');
		expect(DEV_PAGE_HTML).toContain('<style>');
		expect(DEV_PLACEHOLDER_SECURITY_HEADERS['X-Frame-Options']).toBe('SAMEORIGIN');
		expect(DEV_PAGE_SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
	});
});
