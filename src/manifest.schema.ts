import { z } from 'zod';

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
		name: z.string(),
		template: z.string(),
		mock: z.string(),
		format: z.string().optional(),
		orientation: z.string().optional(),
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
		version: z.string(),
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
	const summary = issues
		.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
		.join('; ');
	throw new ManifestValidationError(
		`Invalid poli-page.json — ${summary}`,
		issues
	);
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
