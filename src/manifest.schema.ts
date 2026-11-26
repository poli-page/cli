import { z } from 'zod';
import { isOrientation, isPageFormat, ORIENTATIONS, PAGE_FORMATS } from './format-resolver.js';
import { TEMPLATE_SLUG_RE } from './project-files.js';
import { assertSafeRelativePath } from './security/paths.js';

// These fields become paths: `templates/<name>/<template>`, the mock read
// sent as render data, and `output/<name>/<format>-<orientation>/`.
function safeRelativePath(field: string) {
	return z.string().superRefine((p, ctx) => {
		try {
			assertSafeRelativePath(p, field);
		} catch (err) {
			ctx.addIssue({ code: 'custom', message: (err as Error).message });
		}
	});
}

const fontEntrySchema = z
	.object({
		family: z.string(),
		src: z.string(),
		weight: z.number(),
		style: z.string().optional(),
	})
	.passthrough();

const templateEntrySchema = z
	.object({
		name: z.string().regex(TEMPLATE_SLUG_RE, {
			message: 'expected a slug of lowercase letters, digits and "-"',
		}),
		template: safeRelativePath('template'),
		mock: safeRelativePath('mock'),
		format: z
			.string()
			.refine(isPageFormat, { message: `expected one of ${PAGE_FORMATS.join(', ')}` })
			.optional(),
		orientation: z
			.string()
			.refine(isOrientation, { message: `expected ${ORIENTATIONS.join(' or ')}` })
			.optional(),
	})
	.passthrough();

const cloudSchema = z
	.object({
		orgSlug: z.string(),
		orgId: z.string().optional(),
		projectSlug: z.string().optional(),
		projectId: z.string(),
		apiUrl: z.string().optional(),
	})
	.passthrough();

const projectSchema = z
	.object({
		name: z.string(),
		description: z.string().optional(),
	})
	.passthrough();

const engineSchema = z
	.object({
		paginationOptions: z
			.object({
				orphanThreshold: z.number().optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

export const manifestSchema = z
	.object({
		project: projectSchema,
		engine: engineSchema.optional(),
		fonts: z.array(fontEntrySchema).optional(),
		templates: z.array(templateEntrySchema).optional(),
		cloud: cloudSchema.optional(),
	})
	.passthrough();

export type PoliPageManifest = z.infer<typeof manifestSchema>;

export interface ManifestValidationIssue {
	path: string;
	message: string;
}

export class ManifestValidationError extends Error {
	constructor(
		message: string,
		public readonly issues: ManifestValidationIssue[]
	) {
		super(message);
		this.name = 'ManifestValidationError';
	}
}

export function parseManifest(raw: unknown): PoliPageManifest {
	const result = manifestSchema.safeParse(raw);
	if (result.success) {
		return result.data;
	}
	const issues: ManifestValidationIssue[] = result.error.issues.map((issue) => ({
		path: formatPath(issue.path),
		message: issue.message,
	}));
	const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
	throw new ManifestValidationError(`Invalid poli-page.json — ${summary}`, issues);
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
	let out = '';
	for (const segment of path) {
		if (typeof segment === 'number') {
			out += `[${segment}]`;
		} else {
			out += out === '' ? String(segment) : `.${String(segment)}`;
		}
	}
	return out;
}
