import { Command } from 'commander';
import {
	executeDocumentsThumbnails,
	type DocumentsThumbnailFile,
	type DocumentsThumbnailsOptions,
} from './documents/thumbnails.js';
import { errorToExitCode } from '../exit-codes.js';

export async function executeThumbnailAlias(
	documentId: string | undefined,
	options: DocumentsThumbnailsOptions = {}
): Promise<DocumentsThumbnailFile[]> {
	if (!documentId) {
		throw new Error(
			'Missing <documentId>. Generate a document with `poli render document <name>` first, then run `poli thumbnail <documentId>`.'
		);
	}
	return executeDocumentsThumbnails(documentId, options);
}

function parsePages(value: string): number[] {
	return value
		.split(',')
		.map((s) => Number.parseInt(s.trim(), 10))
		.filter((n) => Number.isFinite(n) && n > 0);
}

export function registerThumbnailCommand(program: Command): void {
	program
		.command('thumbnail [documentId]')
		.description(
			'Alias for `poli documents thumbnails <id>` — regenerate thumbnails from a stored document'
		)
		.option('-w, --width <px>', 'Thumbnail width in pixels', (v) => Number.parseInt(v, 10))
		.option('-f, --format <format>', 'png or jpeg (default jpeg)')
		.option('-q, --quality <n>', 'JPEG quality 1-100', (v) => Number.parseInt(v, 10))
		.option('--pages <list>', 'Comma-separated page numbers (e.g. "1,3")', parsePages)
		.option('-o, --output <dir>', 'Output directory')
		.option('--json', 'Output base64 thumbnails as JSON')
		.action(
			async (
				documentId: string | undefined,
				opts: {
					width?: number;
					format?: 'png' | 'jpeg';
					quality?: number;
					pages?: number[];
					output?: string;
					json?: boolean;
				}
			) => {
				const { default: chalk } = await import('chalk');
				const { default: ora } = await import('ora');

				const spinner = documentId
					? ora(`Generating thumbnails for ${documentId}…`).start()
					: null;
				try {
					const results = await executeThumbnailAlias(documentId, {
						width: opts.width,
						format: opts.format,
						quality: opts.quality,
						pages: opts.pages,
						output: opts.output,
					});

					if (opts.json) {
						spinner?.stop();
						console.log(JSON.stringify(results, null, 2));
						return;
					}

					const summary = results
						.map((r) => `  ${r.width}×${r.height} → ${r.path}`)
						.join('\n');
					spinner?.succeed(
						chalk.green(
							`${results.length} thumbnail(s) generated:\n${summary}`
						)
					);
				} catch (err) {
					spinner?.fail(
						chalk.red(
							err instanceof Error ? err.message : 'Thumbnail failed'
						)
					);
					if (!spinner) {
						console.error(
							chalk.red(
								err instanceof Error ? err.message : 'Thumbnail failed'
							)
						);
					}
					process.exitCode = errorToExitCode(err);
				}
			}
		);
}
