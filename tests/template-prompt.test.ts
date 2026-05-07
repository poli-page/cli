import { describe, it, expect, vi } from 'vitest';
import { promptForStarterTemplate } from '../src/template-prompt.js';
import type { TemplateIndex } from '../src/template-importer.js';

const fakeIndex: TemplateIndex = {
	collections: {
		showcase: {
			title: 'Showcase',
			description: 'Real-world examples (invoice, contract, certificate, …)',
			templates: [
				{ name: 'invoice', description: 'B2B invoice with line items' },
				{ name: 'contract', description: 'Multi-page contract' },
			],
		},
		structures: {
			title: 'Structures',
			description: 'Layout primitives (header-main-footer, …)',
			templates: [
				{ name: 'blank', description: 'Empty page, no layout' },
				{ name: 'header-main-footer', description: 'Standard 3-band layout' },
			],
		},
	},
};

describe('promptForStarterTemplate', () => {
	it('returns null when the user declines the initial confirmation', async () => {
		const result = await promptForStarterTemplate({
			isTTY: true,
			confirmFn: async () => false,
			selectFn: async () => {
				throw new Error('selectFn should not be called');
			},
			fetchIndex: async () => fakeIndex,
		});

		expect(result).toBeNull();
	});

	it('prompts for collection then template, and returns the chosen ref', async () => {
		const askedConfirms: string[] = [];
		const askedSelects: string[] = [];

		const result = await promptForStarterTemplate({
			isTTY: true,
			confirmFn: async ({ message }) => {
				askedConfirms.push(message);
				return true;
			},
			selectFn: async ({ message, choices }) => {
				askedSelects.push(message);
				// First call → pick "showcase" collection
				// Second call → pick "invoice" template
				if (askedSelects.length === 1) {
					return choices.find((c) => c.value === 'showcase')!.value;
				}
				return choices.find((c) => c.value === 'invoice')!.value;
			},
			fetchIndex: async () => fakeIndex,
		});

		expect(result).toEqual({ collection: 'showcase', name: 'invoice' });
		expect(askedConfirms).toHaveLength(1);
		expect(askedSelects).toHaveLength(2);
		expect(askedSelects[0]).toMatch(/collection/i);
		expect(askedSelects[1]).toMatch(/showcase/);
	});

	it('returns null in non-TTY contexts (CI) without prompting', async () => {
		const confirmFn = vi.fn();
		const selectFn = vi.fn();

		const result = await promptForStarterTemplate({
			isTTY: false,
			confirmFn,
			selectFn,
			fetchIndex: async () => fakeIndex,
		});

		expect(result).toBeNull();
		expect(confirmFn).not.toHaveBeenCalled();
		expect(selectFn).not.toHaveBeenCalled();
	});

	it('exposes collection descriptions in the choice labels', async () => {
		let collectionChoiceLabels: string[] = [];

		await promptForStarterTemplate({
			isTTY: true,
			confirmFn: async () => true,
			selectFn: async ({ choices, message }) => {
				if (/collection/i.test(message)) {
					collectionChoiceLabels = choices.map((c) => c.name);
					return choices[0].value;
				}
				return choices[0].value;
			},
			fetchIndex: async () => fakeIndex,
		});

		expect(collectionChoiceLabels).toHaveLength(2);
		expect(collectionChoiceLabels[0]).toContain('showcase');
		expect(collectionChoiceLabels[0]).toContain('Real-world examples');
		expect(collectionChoiceLabels[1]).toContain('structures');
	});

	it('exposes template descriptions in the choice labels', async () => {
		let templateChoiceLabels: string[] = [];

		await promptForStarterTemplate({
			isTTY: true,
			confirmFn: async () => true,
			selectFn: async ({ choices, message }) => {
				if (/collection/i.test(message)) {
					return 'showcase';
				}
				templateChoiceLabels = choices.map((c) => c.name);
				return choices[0].value;
			},
			fetchIndex: async () => fakeIndex,
		});

		expect(templateChoiceLabels).toHaveLength(2);
		expect(templateChoiceLabels[0]).toContain('invoice');
		expect(templateChoiceLabels[0]).toContain('B2B invoice with line items');
	});

	it('throws when fetchIndex fails', async () => {
		await expect(
			promptForStarterTemplate({
				isTTY: true,
				confirmFn: async () => true,
				selectFn: async () => 'whatever',
				fetchIndex: async () => {
					throw new Error('Failed to fetch index.json (HTTP 404).');
				},
			})
		).rejects.toThrow(/Failed to fetch/);
	});
});
