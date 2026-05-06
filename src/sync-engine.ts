import { createHash } from 'node:crypto';
import { ApiError, OrgMigratingError, type PatchFilesEntry, type PatchFilesResult } from './api-client.js';

export function hashContent(content: string | Buffer): string {
	return createHash('sha256').update(content).digest('hex');
}

export interface ComputeDeltaResult {
	added: PatchFilesEntry[];
	modified: PatchFilesEntry[];
	deleted: string[];
	newHashes: Map<string, string>;
}

const NETWORK_BACKOFF_SCHEDULE_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const MIGRATING_RETRY_DELAY_MS = 5000;

export interface SyncWithRetryOptions {
	syncFn: () => Promise<PatchFilesResult>;
	sleepFn?: (ms: number) => Promise<void>;
	signal?: AbortSignal;
}

export async function syncWithRetry(
	options: SyncWithRetryOptions
): Promise<PatchFilesResult> {
	const sleep = options.sleepFn ?? defaultSleep;
	let networkAttempt = 0;

	while (true) {
		if (options.signal?.aborted) {
			throw new Error('Sync aborted.');
		}

		try {
			const result = await options.syncFn();
			return result;
		} catch (err) {
			if (options.signal?.aborted) {
				throw new Error('Sync aborted.');
			}
			if (err instanceof OrgMigratingError) {
				await sleep(MIGRATING_RETRY_DELAY_MS);
				continue;
			}
			if (err instanceof ApiError) {
				// Any other typed API error is non-retryable — surface to caller.
				throw err;
			}
			// Treat anything else (TypeError fetch failed, ECONNRESET, …) as transient
			// network failure and back off exponentially.
			const delay =
				NETWORK_BACKOFF_SCHEDULE_MS[
					Math.min(networkAttempt, NETWORK_BACKOFF_SCHEDULE_MS.length - 1)
				];
			networkAttempt += 1;
			await sleep(delay);
		}
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function computeDelta(
	oldHashes: Map<string, string>,
	newFiles: Map<string, string>
): ComputeDeltaResult {
	const added: PatchFilesEntry[] = [];
	const modified: PatchFilesEntry[] = [];
	const deleted: string[] = [];
	const newHashes = new Map<string, string>();

	for (const [path, content] of newFiles) {
		const newHash = hashContent(content);
		newHashes.set(path, newHash);
		const oldHash = oldHashes.get(path);
		if (oldHash === undefined) {
			added.push({ path, content });
		} else if (oldHash !== newHash) {
			modified.push({ path, content });
		}
	}

	for (const path of oldHashes.keys()) {
		if (!newFiles.has(path)) {
			deleted.push(path);
		}
	}

	return { added, modified, deleted, newHashes };
}
