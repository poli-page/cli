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

// Both ids become path segments of the API calls made with the session. The
// shape is enough for that; z.uuid() would also pin the version and variant.
const cloudIdSchema = z.guid({ error: 'must be a UUID' });

const cloudSchema = z
	.object({
		orgSlug: z.string(),
		orgId: cloudIdSchema.optional(),
		projectSlug: z.string().optional(),
		projectId: cloudIdSchema,
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

/** `parseManifest` of `raw` without its `cloud` block, for a caller that drops it. */
export function parseManifestWithoutCloud(raw: unknown): PoliPageManifest {
	if (typeof raw !== 'object' || raw === null) return parseManifest(raw);
	const { cloud: _dropped, ...rest } = raw as Record<string, unknown>;
	return parseManifest(rest);
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
