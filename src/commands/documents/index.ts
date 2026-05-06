import { Command } from 'commander';
import { registerDocumentsGetCommand } from './get.js';
import { registerDocumentsDeleteCommand } from './delete.js';
import { registerDocumentsThumbnailsCommand } from './thumbnails.js';
import { registerDocumentsPreviewCommand } from './preview.js';

export function registerDocumentsCommands(program: Command): void {
	const documents = program
		.command('documents')
		.description(
			'Manage stored documents (get, delete, thumbnails, preview). No `list` — track ids in your application.'
		);

	registerDocumentsGetCommand(documents);
	registerDocumentsDeleteCommand(documents);
	registerDocumentsThumbnailsCommand(documents);
	registerDocumentsPreviewCommand(documents);
}
