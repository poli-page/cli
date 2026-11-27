import { mkdir, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_MAX_TOTAL_BYTES } from '../../src/project-sync.js';

/**
 * Plants images that each pass the per-file limit but together pass the
 * project's total, as sparse files so the test writes almost nothing.
 */
export async function plantImagesOverTotalLimit(projectDir: string): Promise<void> {
	const images = join(projectDir, 'assets', 'images');
	await mkdir(images, { recursive: true });
	for (const name of ['a.png', 'b.png', 'c.png']) {
		await writeFile(join(images, name), '');
		await truncate(join(images, name), Math.ceil(PROJECT_MAX_TOTAL_BYTES / 3));
	}
}
