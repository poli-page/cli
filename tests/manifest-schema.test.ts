import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifest, writeManifest } from '../src/manifest.js';
import { MANIFEST_FILENAME } from '../src/constants.js';

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
				project: { name: 'p', version: '1.0', description: 'desc' },
				engine: { paginationOptions: { orphanThreshold: 0.08 } },
				fonts: [
					{ family: 'Inter', src: 'fonts/inter-400.woff2', weight: 400, style: 'normal' },
				],
				templates: [
					{ name: 'invoice', template: 'invoice.html', mock: 'invoice.json', format: 'A4', orientation: 'portrait' },
				],
				cloud: {
					orgSlug: 'acme',
					orgId: 'org_uuid',
					projectSlug: 'p',
					projectId: 'proj_1',
				},
			});
			const m = await readManifest(dir);
			expect(m.project.name).toBe('p');
			expect(m.fonts?.[0].family).toBe('Inter');
			expect(m.cloud?.orgId).toBe('org_uuid');
		});

		it('parses a minimal manifest (only project)', async () => {
			await writeRaw({ project: { name: 'p', version: '1.0' } });
			const m = await readManifest(dir);
			expect(m.project.name).toBe('p');
			expect(m.fonts).toBeUndefined();
			expect(m.cloud).toBeUndefined();
		});

		it('accepts a legacy cloud section with only orgSlug + projectId (compat)', async () => {
			await writeRaw({
				project: { name: 'p', version: '1.0' },
				cloud: { orgSlug: 'acme', projectId: 'proj_1' },
			});
			const m = await readManifest(dir);
			expect(m.cloud?.orgSlug).toBe('acme');
			expect(m.cloud?.orgId).toBeUndefined();
		});
	});

	describe('validation errors', () => {
		it('throws when project is missing', async () => {
			await writeRaw({ fonts: [] });
			await expect(readManifest(dir)).rejects.toThrow(/project/);
		});

		it('throws with the field path when project.name is missing', async () => {
			await writeRaw({ project: { version: '1.0' } });
			await expect(readManifest(dir)).rejects.toThrow(/project\.name/);
		});

		it('throws with the field path when fonts[0].weight is the wrong type', async () => {
			await writeRaw({
				project: { name: 'p', version: '1.0' },
				fonts: [{ family: 'Inter', src: 'inter.woff2', weight: 'four-hundred' }],
			});
			await expect(readManifest(dir)).rejects.toThrow(/fonts\[0\]\.weight/);
		});

		it('throws with the field path when templates[0].name is missing', async () => {
			await writeRaw({
				project: { name: 'p', version: '1.0' },
				templates: [{ template: 'x.html', mock: 'x.json' }],
			});
			await expect(readManifest(dir)).rejects.toThrow(/templates\[0\]\.name/);
		});

		it('throws with the field path when cloud.orgSlug is the wrong type', async () => {
			await writeRaw({
				project: { name: 'p', version: '1.0' },
				cloud: { orgSlug: 42, projectId: 'proj_1' },
			});
			await expect(readManifest(dir)).rejects.toThrow(/cloud\.orgSlug/);
		});

		it('throws when JSON is malformed', async () => {
			await writeFile(
				join(dir, MANIFEST_FILENAME),
				'{ "project": invalid }',
				'utf-8'
			);
			await expect(readManifest(dir)).rejects.toThrow();
		});
	});

	describe('round-trip preservation', () => {
		it('preserves an unknown top-level field across read → write → read', async () => {
			await writeRaw({
				project: { name: 'p', version: '1.0' },
				customSection: { foo: 'bar', n: 42 },
			});
			const m = await readManifest(dir);
			await writeManifest(dir, m);
			const raw = JSON.parse(await readFile(join(dir, MANIFEST_FILENAME), 'utf-8'));
			expect(raw.customSection).toEqual({ foo: 'bar', n: 42 });
		});

		it('preserves an unknown field inside project', async () => {
			await writeRaw({
				project: { name: 'p', version: '1.0', author: 'Xavier' },
			});
			const m = await readManifest(dir);
			await writeManifest(dir, m);
			const raw = JSON.parse(await readFile(join(dir, MANIFEST_FILENAME), 'utf-8'));
			expect(raw.project.author).toBe('Xavier');
		});

		it('preserves field order on read → write', async () => {
			await writeRaw({
				project: { name: 'p', version: '1.0' },
				fonts: [],
				templates: [],
				cloud: {
					orgSlug: 'a',
					orgId: 'o',
					projectSlug: 'p',
					projectId: 'pp',
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
