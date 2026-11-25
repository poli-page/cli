import { UsageError } from '../../exit-codes.js';
import { isSafeSegment } from '../../security/paths.js';

// The ID is a segment of the default output path: refuse anything that
// could make that path leave its folder.
export function assertDocumentId(id: string): void {
	if (!isSafeSegment(id) || id.includes('..')) {
		throw new UsageError(
			`Invalid document ID ${JSON.stringify(id)}: expected letters, digits, ".", "_" and "-".`
		);
	}
}
