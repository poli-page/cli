import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CREDENTIALS_DIR, CREDENTIALS_FILENAME } from './constants.js';

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
	session: string;
	user: UserInfo;
	orgs: Record<string, OrgCredentials>;
}

function getCredentialsPath(homeDir?: string): string {
	const home = homeDir ?? homedir();
	return join(home, CREDENTIALS_DIR, CREDENTIALS_FILENAME);
}

function getCredentialsDir(homeDir?: string): string {
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
	const dir = getCredentialsDir(homeDir);
	const path = getCredentialsPath(homeDir);
	// mkdir/writeFile modes only apply on creation and go through the umask:
	// chmod both so an existing or umask-widened dir/file ends up 0700/0600.
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	// Tighten an existing file before the new secrets go in; fail closed if we can't.
	await chmod(path, 0o600).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== 'ENOENT') throw error;
	});
	await writeFile(path, JSON.stringify(credentials, null, '\t') + '\n', {
		encoding: 'utf-8',
		mode: 0o600,
	});
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

export async function getSessionToken(homeDir?: string): Promise<string> {
	const credentials = await readCredentials(homeDir);
	if (!credentials?.session) {
		throw new Error('Not logged in. Run "poli login" first.');
	}
	return credentials.session;
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
