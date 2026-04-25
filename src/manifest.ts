import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MANIFEST_FILENAME } from './constants.js';

export interface PoliPageManifest {
	project: {
		name: string;
		version: string;
		description?: string;
	};
	engine?: {
		paginationOptions?: {
			orphanThreshold?: number;
		};
	};
	fonts?: Array<{
		family: string;
		src: string;
		weight: number;
		style?: string;
	}>;
	templates?: Array<{
		name: string;
		template: string;
		mock: string;
		format?: string;
		orientation?: string;
	}>;
	cloud?: {
		orgSlug: string;
		projectId: string;
		apiUrl?: string;
	};
}

export async function readManifest(projectDir: string): Promise<PoliPageManifest> {
	const manifestPath = join(projectDir, MANIFEST_FILENAME);
	const content = await readFile(manifestPath, 'utf-8');
	return JSON.parse(content);
}

export async function writeManifest(projectDir: string, manifest: PoliPageManifest): Promise<void> {
	const manifestPath = join(projectDir, MANIFEST_FILENAME);
	await writeFile(manifestPath, JSON.stringify(manifest, null, '\t') + '\n', 'utf-8');
}
