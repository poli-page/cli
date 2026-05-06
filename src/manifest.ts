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
