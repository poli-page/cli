import { describe, it, expect } from 'vitest';
import { DEV_ERROR_TITLES, DEV_PAGE_HTML } from '../src/dev-page.js';
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
		const stages: Array<DevError['stage']> = ['sync', 'render', 'pdf', 'project'];
		const titles = stages.map((stage) => DEV_ERROR_TITLES[stage]);

		// Every stage has its own non-empty, distinct title — no stage
		// falls back to another stage's wording.
		expect(titles.every((title) => title.length > 0)).toBe(true);
		expect(new Set(titles).size).toBe(stages.length);
		expect(DEV_ERROR_TITLES.sync).toBe('Sync failed');
		expect(DEV_ERROR_TITLES.render).toBe('Render failed');
		expect(DEV_ERROR_TITLES.pdf).toMatch(/PDF/);
		expect(DEV_ERROR_TITLES.project).toMatch(/project/i);

		// The page embeds the table verbatim, so the browser shows exactly
		// these titles.
		expect(DEV_PAGE_HTML).toContain(JSON.stringify(DEV_ERROR_TITLES));
	});
});
