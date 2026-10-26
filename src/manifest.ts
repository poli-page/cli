import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MANIFEST_FILENAME } from './constants.js';
import { parseManifest, type PoliPageManifest } from './manifest.schema.js';

export type { PoliPageManifest } from './manifest.schema.js';
export {
	ManifestValidationError,
	type ManifestValidationIssue,
} from './manifest.schema.js';

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
		if (err instanceof Error && /ENOENT/.test(err.message)) {
			throw new Error(
				`No ${MANIFEST_FILENAME} found in ${projectDir}. Are you in a Poli Page project?`
			);
		}
		throw err;
	}
}

export async function writeManifest(
	projectDir: string,
	manifest: PoliPageManifest
): Promise<void> {
	const manifestPath = join(projectDir, MANIFEST_FILENAME);
	await writeFile(
		manifestPath,
		JSON.stringify(manifest, null, '\t') + '\n',
		'utf-8'
	);
}
