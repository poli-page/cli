import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CREDENTIALS_DIR, CREDENTIALS_FILENAME } from './constants.js';
import { apiOrigin, DEFAULT_API_URL } from './api-origin.js';
import { ExitCode } from './exit-codes.js';

export interface UserInfo {
	id: string;
	name: string;
	email: string;
}

export interface OrgCredentials {
	testKey?: string;
	liveKey?: string;
}

export interface StoredCredentials {
	apiUrl?: string;
	/** The API origin that issued `session`; a file without it means the default origin. */
	origin?: string;
	session: string;
	user: UserInfo;
	orgs: Record<string, OrgCredentials>;
}

function getCredentialsPath(homeDir?: string): string {
	const home = homeDir ?? homedir();
	return join(home, CREDENTIALS_DIR, CREDENTIALS_FILENAME);
}

export function getCredentialsDir(homeDir?: string): string {
	const home = homeDir ?? homedir();
	return join(home, CREDENTIALS_DIR);
}

export async function readCredentials(homeDir?: string): Promise<StoredCredentials | null> {
	const path = getCredentialsPath(homeDir);
	try {
		const content = await readFile(path, 'utf-8');
		return JSON.parse(content);
	} catch {
		return null;
	}
}

export async function writeCredentials(
	credentials: StoredCredentials,
	homeDir?: string
): Promise<void> {
	await writePrivateFile(
		CREDENTIALS_FILENAME,
		JSON.stringify(credentials, null, '\t') + '\n',
		homeDir
	);
}

/** Writes `~/.polipage/<filename>` readable by the user only (dir 0700, file 0600). */
export async function writePrivateFile(
	filename: string,
	content: string,
	homeDir?: string
): Promise<void> {
	const dir = getCredentialsDir(homeDir);
	const path = join(dir, filename);
	// mkdir/writeFile modes only apply on creation and go through the umask:
	// chmod both so an existing or umask-widened dir/file ends up 0700/0600.
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	// Tighten an existing file before the new content goes in; fail closed if we can't.
	await chmod(path, 0o600).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== 'ENOENT') throw error;
	});
	await writeFile(path, content, { encoding: 'utf-8', mode: 0o600 });
	await chmod(path, 0o600);
}

export async function clearCredentials(homeDir?: string): Promise<void> {
	const path = getCredentialsPath(homeDir);
	try {
		const { unlink } = await import('node:fs/promises');
		await unlink(path);
	} catch {
		// Already gone — that's fine
	}
}

export async function updateOrgKeys(
	orgSlug: string,
	keys: OrgCredentials,
	homeDir?: string
): Promise<void> {
	const credentials = await readCredentials(homeDir);
	if (!credentials) {
		throw new Error('Not logged in. Run "poli login" first.');
	}
	credentials.orgs[orgSlug] = { ...credentials.orgs[orgSlug], ...keys };
	await writeCredentials(credentials, homeDir);
}

export class SessionOriginError extends Error {
	readonly exitCode = ExitCode.NOT_AUTHENTICATED;
}

/** The stored session, refused for any API origin other than the one that issued it. */
export function sessionFor(credentials: StoredCredentials, origin = apiOrigin()): string {
	const issuer = credentials.origin ?? DEFAULT_API_URL;
	if (issuer !== origin) {
		throw new SessionOriginError(
			`Your session was issued by ${issuer}, not ${origin}. Run \`poli login\` against ${origin}.`
		);
	}
	return credentials.session;
}

export async function getSessionToken(homeDir?: string): Promise<string> {
	const credentials = await readCredentials(homeDir);
	if (!credentials?.session) {
		throw new Error('Not logged in. Run "poli login" first.');
	}
	return sessionFor(credentials);
}

export async function getApiKey(
	orgSlug: string,
	environment: 'test' | 'live',
	homeDir?: string
): Promise<string> {
	const credentials = await readCredentials(homeDir);
	if (!credentials) {
		throw new Error('Not logged in. Run "poli login" first.');
	}
	const orgCreds = credentials.orgs[orgSlug];
	if (!orgCreds) {
		throw new Error(`No credentials for organization "${orgSlug}". Run "poli link" first.`);
	}
	const key = environment === 'live' ? orgCreds.liveKey : orgCreds.testKey;
	if (!key) {
		throw new Error(
			`No ${environment} API key for "${orgSlug}". Create one via the dashboard.`
		);
	}
	return key;
}
