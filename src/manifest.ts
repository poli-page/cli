import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MANIFEST_FILENAME } from './constants.js';
import { parseManifest, type PoliPageManifest } from './manifest.schema.js';

export type { PoliPageManifest } from './manifest.schema.js';
export { ManifestValidationError, type ManifestValidationIssue } from './manifest.schema.js';

export async function readManifest(projectDir: string): Promise<PoliPageManifest> {
	const manifestPath = join(projectDir, MANIFEST_FILENAME);
	const content = await readFile(manifestPath, 'utf-8');
	const raw = JSON.parse(content);
	return parseManifest(raw);
}

/** `readManifest`, reporting a missing file as "not in a Poli Page project". */
export async function readProjectManifest(projectDir: string): Promise<PoliPageManifest> {
	try {
		return await readManifest(projectDir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(
				`No ${MANIFEST_FILENAME} found in ${projectDir}. Are you in a Poli Page project?`
			);
		}
		throw err;
	}
}

/** The manifest's `cloud` block, or `undefined` when the folder has no poli-page.json. */
export async function readCloudLink(projectDir: string): Promise<PoliPageManifest['cloud']> {
	try {
		return (await readManifest(projectDir)).cloud;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw err;
	}
}

/**
 * Writes `poli-page.json`. `project.version` and `cloud.track` went away
 * with versions (F3), but the passthrough schema keeps them on read, so
 * every write drops them, without a word.
 */
export async function writeManifest(projectDir: string, manifest: PoliPageManifest): Promise<void> {
	await writeFile(join(projectDir, MANIFEST_FILENAME), serializeManifest(manifest), 'utf-8');
}

/** The bytes `writeManifest` writes, for a caller that writes them itself. */
export function serializeManifest(manifest: PoliPageManifest): string {
	return JSON.stringify(withoutRetiredFields(manifest), null, '\t') + '\n';
}

function withoutRetiredFields(manifest: PoliPageManifest): PoliPageManifest {
	const { version: _version, ...project } = manifest.project;
	const out: PoliPageManifest = { ...manifest, project };
	if (manifest.cloud) {
		const { track: _track, ...cloud } = manifest.cloud;
		out.cloud = cloud;
	}
	return out;
}
