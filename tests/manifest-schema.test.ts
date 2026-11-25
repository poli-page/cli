import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifest, writeManifest } from '../src/manifest.js';
import { MANIFEST_FILENAME } from '../src/constants.js';
import { parseManifestWithoutCloud } from '../src/manifest.schema.js';

const ORG_ID = '0e89d99e-1516-4b48-baa1-f49e660ad1c1';
const PROJECT_ID = '8274f64d-4ea2-4f96-b596-5727a7b17268';

describe('manifest schema validation', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'poli-manifest-'));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function writeRaw(content: object) {
		await writeFile(
			join(dir, MANIFEST_FILENAME),
			JSON.stringify(content, null, '\t') + '\n',
			'utf-8'
		);
	}

	describe('valid manifests', () => {
		it('parses a full well-formed manifest', async () => {
			await writeRaw({
				project: { name: 'p', description: 'desc' },
				engine: { paginationOptions: { orphanThreshold: 0.08 } },
				fonts: [
					{ family: 'Inter', src: 'fonts/inter-400.woff2', weight: 400, style: 'normal' },
				],
				templates: [
					{
						name: 'invoice',
						template: 'invoice.html',
						mock: 'invoice.json',
						format: 'A4',
						orientation: 'portrait',
					},
				],
				cloud: {
					orgSlug: 'acme',
					orgId: ORG_ID,
					projectSlug: 'p',
					projectId: PROJECT_ID,
				},
			});
			const m = await readManifest(dir);
			expect(m.project.name).toBe('p');
			expect(m.fonts?.[0].family).toBe('Inter');
			expect(m.cloud?.orgId).toBe(ORG_ID);
		});

		it('parses a minimal manifest (only project)', async () => {
			await writeRaw({ project: { name: 'p' } });
			const m = await readManifest(dir);
			expect(m.project.name).toBe('p');
			expect(m.fonts).toBeUndefined();
			expect(m.cloud).toBeUndefined();
		});

		it('loads a manifest that still carries project.version and cloud.track, whatever their values', async () => {
			await writeRaw({
				project: { name: 'p', version: 1 },
				cloud: { orgSlug: 'acme', projectId: PROJECT_ID, track: 'not-a-family' },
			});
			const m = await readManifest(dir);
			expect(m.project.name).toBe('p');
			expect(m.cloud?.projectId).toBe(PROJECT_ID);
		});

		it('accepts a legacy cloud section with only orgSlug + projectId (compat)', async () => {
			await writeRaw({
				project: { name: 'p' },
				cloud: { orgSlug: 'acme', projectId: PROJECT_ID },
			});
			const m = await readManifest(dir);
			expect(m.cloud?.orgSlug).toBe('acme');
			expect(m.cloud?.orgId).toBeUndefined();
		});

		// The check guards the path, not how the server generates its ids.
		it('accepts any id of the UUID shape, whatever its version digit', async () => {
			const id = '00000000-0000-0000-0000-000000000001';
			await writeRaw({
				project: { name: 'p' },
				cloud: { orgSlug: 'acme', orgId: id, projectId: id },
			});
			const m = await readManifest(dir);
			expect(m.cloud?.projectId).toBe(id);
		});
	});

	describe('parseManifestWithoutCloud', () => {
		it('ignores an invalid cloud block and drops it', () => {
			const m = parseManifestWithoutCloud({
				project: { name: 'p' },
				cloud: { projectId: 'proj_1' },
			});
			expect(m).toEqual({ project: { name: 'p' } });
		});

		it.each([null, 'text'])('reports %j as an invalid manifest', (raw) => {
			expect(() => parseManifestWithoutCloud(raw)).toThrow(/^Invalid poli-page\.json/);
		});
	});

	describe('validation errors', () => {
		it('throws when project is missing', async () => {
			await writeRaw({ fonts: [] });
			await expect(readManifest(dir)).rejects.toThrow(/project/);
		});

		it('throws with the field path when project.name is missing', async () => {
			await writeRaw({ project: { description: 'no name' } });
			await expect(readManifest(dir)).rejects.toThrow(/project\.name/);
		});

		it('throws with the field path when fonts[0].weight is the wrong type', async () => {
			await writeRaw({
				project: { name: 'p' },
				fonts: [{ family: 'Inter', src: 'inter.woff2', weight: 'four-hundred' }],
			});
			await expect(readManifest(dir)).rejects.toThrow(/fonts\[0\]\.weight/);
		});

		it('throws with the field path when templates[0].name is missing', async () => {
			await writeRaw({
				project: { name: 'p' },
				templates: [{ template: 'x.html', mock: 'x.json' }],
			});
			await expect(readManifest(dir)).rejects.toThrow(/templates\[0\]\.name/);
		});

		it('throws with the field path when cloud.orgSlug is the wrong type', async () => {
			await writeRaw({
				project: { name: 'p' },
				cloud: { orgSlug: 42, projectId: PROJECT_ID },
			});
			await expect(readManifest(dir)).rejects.toThrow(/cloud\.orgSlug/);
		});

		// Both ids become URL path segments of the session's API calls.
		it.each([
			['projectId', { orgSlug: 'acme', projectId: '../../../../api/anything?x=' }],
			['projectId', { orgSlug: 'acme', projectId: 'proj_1' }],
			['orgId', { orgSlug: 'acme', orgId: '..', projectId: PROJECT_ID }],
			['orgId', { orgSlug: 'acme', orgId: 'org_1', projectId: PROJECT_ID }],
		])('rejects a cloud.%s that is not a UUID', async (field, cloud) => {
			await writeRaw({ project: { name: 'p' }, cloud });
			await expect(readManifest(dir)).rejects.toThrow(
				`Invalid poli-page.json — cloud.${field}: must be a UUID`
			);
		});

		it('throws when JSON is malformed', async () => {
			await writeFile(join(dir, MANIFEST_FILENAME), '{ "project": invalid }', 'utf-8');
			await expect(readManifest(dir)).rejects.toThrow(/^Invalid poli-page\.json — /);
		});
	});

	describe('round-trip preservation', () => {
		it('preserves an unknown top-level field across read → write → read', async () => {
			await writeRaw({
				project: { name: 'p' },
				customSection: { foo: 'bar', n: 42 },
			});
			const m = await readManifest(dir);
			await writeManifest(dir, m);
			const raw = JSON.parse(await readFile(join(dir, MANIFEST_FILENAME), 'utf-8'));
			expect(raw.customSection).toEqual({ foo: 'bar', n: 42 });
		});

		it('preserves an unknown field inside project', async () => {
			await writeRaw({
				project: { name: 'p', author: 'Xavier' },
			});
			const m = await readManifest(dir);
			await writeManifest(dir, m);
			const raw = JSON.parse(await readFile(join(dir, MANIFEST_FILENAME), 'utf-8'));
			expect(raw.project.author).toBe('Xavier');
		});

		it('drops project.version and cloud.track on write, and keeps everything else', async () => {
			await writeRaw({
				project: { name: 'p', version: '1.0.0', author: 'Xavier' },
				templates: [],
				cloud: {
					orgSlug: 'a',
					projectId: PROJECT_ID,
					track: '1.0',
					apiUrl: 'http://localhost:3000',
				},
			});
			const m = await readManifest(dir);
			await writeManifest(dir, m);
			const raw = JSON.parse(await readFile(join(dir, MANIFEST_FILENAME), 'utf-8'));
			expect(raw).toEqual({
				project: { name: 'p', author: 'Xavier' },
				templates: [],
				cloud: { orgSlug: 'a', projectId: PROJECT_ID, apiUrl: 'http://localhost:3000' },
			});
		});

		it('preserves field order on read → write', async () => {
			await writeRaw({
				project: { name: 'p' },
				fonts: [],
				templates: [],
				cloud: {
					orgSlug: 'a',
					orgId: ORG_ID,
					projectSlug: 'p',
					projectId: PROJECT_ID,
				},
			});
			const m = await readManifest(dir);
			await writeManifest(dir, m);
			const written = await readFile(join(dir, MANIFEST_FILENAME), 'utf-8');
			expect(written.indexOf('"project"')).toBeLessThan(written.indexOf('"fonts"'));
			expect(written.indexOf('"fonts"')).toBeLessThan(written.indexOf('"templates"'));
			expect(written.indexOf('"templates"')).toBeLessThan(written.indexOf('"cloud"'));
		});
	});
});
