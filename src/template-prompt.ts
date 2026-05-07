import {
	fetchTemplateIndex,
	type FetchOptions,
	type TemplateIndex,
	type TemplateRef,
	type TemplateSource,
} from './template-importer.js';

export interface SelectChoice<T> {
	name: string;
	value: T;
	description?: string;
}

export type SelectFn = <T>(args: {
	message: string;
	choices: Array<SelectChoice<T>>;
}) => Promise<T>;

export type ConfirmFn = (args: {
	message: string;
	default?: boolean;
}) => Promise<boolean>;

export type InputFn = (args: {
	message: string;
	default?: string;
}) => Promise<string>;

export interface TemplatePromptResult {
	ref: TemplateRef;
	/** Set when promptDestName=true. Defaults to ref.name if the user kept the suggested value. */
	destName?: string;
}

export interface TemplatePromptOptions {
	source?: TemplateSource;
	fetcher?: FetchOptions['fetcher'];
	homeDir?: string;
	noCache?: boolean;
	/**
	 * Whether the current shell is interactive. When false (e.g. CI), the
	 * prompt is skipped entirely and `null` is returned. Defaults to
	 * `process.stdout.isTTY`.
	 */
	isTTY?: boolean;
	/**
	 * After picking a template, also prompt for the destination template
	 * name in the project (default suggestion = source template name).
	 * Used by `poli init` only — `poli new` already takes the destination
	 * as a positional argument.
	 */
	promptDestName?: boolean;
	/** Injectable for testing. Default uses `@inquirer/prompts` confirm. */
	confirmFn?: ConfirmFn;
	/** Injectable for testing. Default uses `@inquirer/prompts` select. */
	selectFn?: SelectFn;
	/** Injectable for testing. Default uses `@inquirer/prompts` input. */
	inputFn?: InputFn;
	/** Injectable for testing. Default fetches from the source repo via fetchTemplateIndex. */
	fetchIndex?: () => Promise<TemplateIndex>;
}

export async function promptForStarterTemplate(
	options: TemplatePromptOptions = {}
): Promise<TemplatePromptResult | null> {
	const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);
	if (!isTTY) {
		return null;
	}

	const confirmFn = options.confirmFn ?? defaultConfirm;
	const wantsTemplate = await confirmFn({
		message: 'Add a starter template?',
		default: false,
	});
	if (!wantsTemplate) {
		return null;
	}

	const fetchIndex =
		options.fetchIndex ??
		(() =>
			fetchTemplateIndex(options.source, {
				fetcher: options.fetcher,
				homeDir: options.homeDir,
				noCache: options.noCache,
			}));
	const index = await fetchIndex();

	const selectFn = options.selectFn ?? defaultSelect;

	const collectionChoices = Object.entries(index.collections).map(
		([key, coll]) => ({
			name: `${key} — ${coll.description}`,
			value: key,
		})
	);

	const collectionKey = await selectFn<string>({
		message: 'Pick a template collection:',
		choices: collectionChoices,
	});

	const collection = index.collections[collectionKey];
	const templateChoices = collection.templates.map((t) => ({
		name: `${t.name} — ${t.description}`,
		value: t.name,
	}));

	const templateName = await selectFn<string>({
		message: `Pick a template from ${collectionKey}:`,
		choices: templateChoices,
	});

	const ref: TemplateRef = { collection: collectionKey, name: templateName };

	if (options.promptDestName) {
		const inputFn = options.inputFn ?? defaultInput;
		const destName = await inputFn({
			message: 'Template name in the project:',
			default: templateName,
		});
		return { ref, destName };
	}

	return { ref };
}

async function defaultConfirm(args: {
	message: string;
	default?: boolean;
}): Promise<boolean> {
	const { confirm } = await import('@inquirer/prompts');
	return confirm({ message: args.message, default: args.default ?? false });
}

async function defaultSelect<T>(args: {
	message: string;
	choices: Array<SelectChoice<T>>;
}): Promise<T> {
	const { select } = await import('@inquirer/prompts');
	return select({
		message: args.message,
		choices: args.choices.map((c) => ({ name: c.name, value: c.value })),
	}) as Promise<T>;
}

async function defaultInput(args: {
	message: string;
	default?: string;
}): Promise<string> {
	const { input } = await import('@inquirer/prompts');
	return input({ message: args.message, default: args.default });
}
