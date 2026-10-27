import type { UserInfo } from './credentials.js';

const DEFAULT_API_URL = 'https://api.poli.page';

export class ApiError extends Error {
	constructor(
		public readonly code: string,
		public readonly httpStatus: number,
		message: string,
		public readonly retryAfter?: number
	) {
		super(message);
		this.name = new.target.name;
	}
}

export class QuotaExceededError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('QUOTA_EXCEEDED', 429, message, retryAfter);
	}
}
export class OverageCapError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('OVERAGE_CAP_EXCEEDED', 429, message, retryAfter);
	}
}
export class OrgPaymentGraceError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('ORGANIZATION_PAYMENT_GRACE', 403, message, retryAfter);
	}
}
export class OrgCancelledError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('ORGANIZATION_CANCELLED', 403, message, retryAfter);
	}
}
export class OrgPurgedError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('ORGANIZATION_PURGED', 410, message, retryAfter);
	}
}
export class OrgMigratingError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('ORGANIZATION_MIGRATING', 503, message, retryAfter);
	}
}
export class MissingOrgContextError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('MISSING_ORG_CONTEXT', 400, message, retryAfter);
	}
}
export class NotAMemberError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('NOT_A_MEMBER', 403, message, retryAfter);
	}
}
export class ThumbnailsNotAvailableError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('THUMBNAILS_NOT_AVAILABLE', 403, message, retryAfter);
	}
}
export class DocumentNotFoundError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('DOCUMENT_NOT_FOUND', 404, message, retryAfter);
	}
}
export class DocumentGoneError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('DOCUMENT_GONE', 410, message, retryAfter);
	}
}
export class EnvironmentProtectedError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('ENVIRONMENT_PROTECTED', 403, message, retryAfter);
	}
}
export class EnvironmentNotFoundError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('ENVIRONMENT_NOT_FOUND', 404, message, retryAfter);
	}
}
export class UnsupportedFileTypeError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('UNSUPPORTED_FILE_TYPE', 400, message, retryAfter);
	}
}
// No class for PUBLISH_IN_PROGRESS: the API sends it as 409 on a publish and
// 503 on a render, and a registry class carries one fixed status.

type TypedErrorCtor = new (message: string, retryAfter?: number) => ApiError;

const TYPED_ERROR_REGISTRY: Record<string, TypedErrorCtor> = {
	QUOTA_EXCEEDED: QuotaExceededError,
	OVERAGE_CAP_EXCEEDED: OverageCapError,
	ORGANIZATION_PAYMENT_GRACE: OrgPaymentGraceError,
	ORGANIZATION_CANCELLED: OrgCancelledError,
	ORGANIZATION_PURGED: OrgPurgedError,
	ORGANIZATION_MIGRATING: OrgMigratingError,
	MISSING_ORG_CONTEXT: MissingOrgContextError,
	NOT_A_MEMBER: NotAMemberError,
	THUMBNAILS_NOT_AVAILABLE: ThumbnailsNotAvailableError,
	DOCUMENT_NOT_FOUND: DocumentNotFoundError,
	DOCUMENT_GONE: DocumentGoneError,
	ENVIRONMENT_PROTECTED: EnvironmentProtectedError,
	ENVIRONMENT_NOT_FOUND: EnvironmentNotFoundError,
	UNSUPPORTED_FILE_TYPE: UnsupportedFileTypeError,
};

export interface DeviceRequestResult {
	deviceCode: string;
	userCode: string;
	verificationUrl: string;
	expiresIn: number;
	interval: number;
}

export interface DevicePollResult {
	status: 'authorization_pending' | 'confirmed' | 'expired';
	sessionToken?: string;
	user?: UserInfo;
}

export interface ThumbnailResult {
	page: number;
	width: number;
	height: number;
	contentType: string;
	data: string; // base64
}

export interface DocumentThumbnailOptions {
	width?: number;
	format?: 'png' | 'jpeg';
	quality?: number;
	pages?: number[];
}

export interface DocumentPreviewResult {
	html: string;
	pageCount: number;
}

/**
 * One project file on the wire (draft sync and publish). The API decodes
 * `content` by `encoding` only, never by the path's extension.
 */
export interface ProjectFileEntry {
	path: string;
	encoding: 'utf8' | 'base64';
	content: string;
}

export interface PatchFilesBody {
	added: ProjectFileEntry[];
	modified: ProjectFileEntry[];
	deleted: string[];
}

/** `POST /v1/projects/:project/publish` body: the whole local project. */
export interface PublishBody {
	environment: string;
	message?: string;
	files: ProjectFileEntry[];
}

export interface PublishResult {
	environment: string;
	project: string;
	publishedAt: string;
	/** `sha256:<64 hex>` */
	bundleHash: string;
	logId: string;
	fileCount: number;
	totalBytes: number;
}

export interface EnvironmentInfo {
	name: string;
	kind: 'sandbox' | 'standard';
	protected: boolean;
	readOnly: boolean;
	createdAt: string;
	projectCount: number;
}

/** One publish attempt in a project's publish log (api-spec §9.3). */
export interface PublishLogEntry {
	id: string;
	status: 'in-progress' | 'succeeded' | 'failed';
	errorCode: string | null;
	startedAt: string;
	publishedAt: string | null;
	author: { type: 'user' | 'service-key'; id: string; displayName: string };
	message: string | null;
	/** `sha256:<64 hex>` */
	bundleHash: string;
	fileCount: number;
	totalBytes: number;
}

/** A project's state in one environment of its organization (api-spec §9.3). */
export interface ProjectEnvironmentState {
	environment: string;
	kind: 'sandbox' | 'standard';
	protected: boolean;
	readOnly: boolean;
	published: boolean;
	/** The newest attempt of any status, so a failed one shows here too. */
	lastPublish: PublishLogEntry | null;
}

export interface PatchFilesResult {
	syncedAt: string;
}

export interface DocumentDescriptor {
	documentId: string;
	organizationId: string;
	projectId: string | null;
	projectSlug: string | null;
	templateId: string | null;
	templateSlug: string | null;
	/** The name of the environment the document was rendered in. */
	environment: string;
	apiKeyId: string | null;
	createdAt: string;
	pageCount: number;
	sizeBytes: number;
	format: string;
	orientation: string | null;
	locale: string | null;
	metadata: Record<string, unknown>;
	presignedPdfUrl: string;
	expiresAt: string;
}

/** Something a render did that its PDF alone does not show (api-spec §11.3). */
export interface RenderDiagnostic {
	kind: 'clipped' | 'missing-asset' | 'dropped-font';
	message: string;
	elementId?: string;
	path?: string;
}

/**
 * Result of `POST /v1/render`: the stored document's descriptor plus the
 * render's diagnostics, which are not stored with the document, so
 * `GET /v1/documents/:id` does not return them (api-spec §11.3).
 */
export type RenderResult = DocumentDescriptor & { diagnostics: RenderDiagnostic[] };

export interface MeResponse {
	auth: {
		mode: 'session' | 'api-key';
		/** `null` for a session. Only a `service` key can publish. */
		keyType: 'standard' | 'service' | null;
		/** The name of the key's environment; `null` for a session. */
		environment: string | null;
		/** The member's role (session), the service key's role, `null` for a standard key. */
		role: 'owner' | 'admin' | 'developer' | null;
	};
	user: {
		id: string;
		email: string;
		name: string;
		username: string;
	} | null;
	key: {
		id: string;
		name: string;
		prefix: string;
		preview: string;
		createdAt: string;
		lastUsedAt: string | null;
	} | null;
	org: {
		id: string;
		slug: string;
		name: string;
		tier: string;
		lifecycleStatus: string;
	} | null;
}

export interface ApiClient {
	signIn(email: string, password: string): Promise<{ user: UserInfo; session: string }>;
	signUp(
		email: string,
		password: string,
		name: string
	): Promise<{ user: UserInfo; session: string }>;
	deviceRequest(): Promise<DeviceRequestResult>;
	devicePoll(deviceCode: string): Promise<DevicePollResult>;
	getOrganizations(session: string): Promise<Array<{ id: string; name: string; slug: string }>>;
	listProjects(
		session: string,
		orgId: string
	): Promise<Array<{ id: string; name: string; slug: string }>>;
	createProject(
		session: string,
		orgId: string,
		payload: Record<string, unknown>
	): Promise<{ id: string }>;
	patchFiles(
		session: string,
		orgId: string,
		projectId: string,
		body: PatchFilesBody
	): Promise<PatchFilesResult>;
	listEnvironments(authorization: string, orgId: string): Promise<EnvironmentInfo[]>;
	getProjectEnvironments(
		session: string,
		orgId: string,
		projectId: string
	): Promise<ProjectEnvironmentState[]>;
	/** `orgIdHeader` is the session's organization; an API key carries its own. */
	publish(
		authorization: string,
		orgIdHeader: string | undefined,
		project: string,
		body: PublishBody
	): Promise<PublishResult>;
	render(
		authorization: string,
		orgIdHeader: string | undefined,
		payload: Record<string, unknown>
	): Promise<RenderResult>;
	/**
	 * `POST /v1/render/draft`: renders the project's draft and answers the
	 * PDF bytes. Session only (an API key gets `403 DRAFT_REQUIRES_SESSION`);
	 * nothing is stored or counted, and no page count comes back.
	 */
	renderDraft(
		authorization: string,
		orgIdHeader: string,
		payload: Record<string, unknown>
	): Promise<Buffer>;
	getMe(authorization: string, orgIdHeader?: string): Promise<MeResponse>;
	// `renderThumbnails` was retired with `/v1/render/thumbnails` (api-spec §11.4).
	// Thumbnails now come from a stored document via `documentThumbnails`.
	getDocument(
		authorization: string,
		orgIdHeader: string | undefined,
		id: string
	): Promise<DocumentDescriptor>;
	deleteDocument(
		authorization: string,
		orgIdHeader: string | undefined,
		id: string
	): Promise<void>;
	documentThumbnails(
		authorization: string,
		orgIdHeader: string | undefined,
		id: string,
		options: DocumentThumbnailOptions
	): Promise<ThumbnailResult[]>;
	documentPreview(
		authorization: string,
		orgIdHeader: string | undefined,
		id: string
	): Promise<DocumentPreviewResult>;
}

export function createApiClient(baseUrl?: string): ApiClient {
	const url = baseUrl ?? process.env.POLI_API_URL ?? DEFAULT_API_URL;

	async function request(path: string, options: RequestInit = {}): Promise<Response> {
		const fullUrl = `${url}${path}`;
		let response: Response;
		try {
			response = await fetch(fullUrl, {
				...options,
				headers: {
					'Content-Type': 'application/json',
					Origin: url,
					...options.headers,
				},
			});
		} catch (err) {
			// Node's fetch surfaces low-level network failures as
			// `TypeError: fetch failed`, hiding the real cause. Unwrap so the
			// CLI prints something actionable (which host failed to resolve,
			// which port refused the connection, …).
			if (err instanceof TypeError && err.message === 'fetch failed') {
				throw new Error(formatNetworkError(fullUrl, err));
			}
			throw err;
		}
		if (!response.ok) {
			throw await buildApiError(response);
		}
		return response;
	}

	/** `value` encoded as one path segment; `label` names it in the error. */
	function idSegment(value: string, label: string): string {
		// encodeURIComponent leaves the dot segments as they are, and the URL
		// parser would resolve them against the path.
		if (value === '.' || value === '..') {
			throw new Error(`Invalid ${label} ID.`);
		}
		return encodeURIComponent(value);
	}

	return {
		async signIn(email, password) {
			const response = await request('/api/auth/sign-in/email', {
				method: 'POST',
				body: JSON.stringify({ email, password }),
			});
			const data = (await response.json()) as { user: UserInfo; token: string };
			return { user: data.user, session: data.token };
		},

		async signUp(email, password, name) {
			const response = await request('/api/auth/sign-up/email', {
				method: 'POST',
				body: JSON.stringify({ email, password, name }),
			});
			const data = (await response.json()) as { user: UserInfo; token: string };
			return { user: data.user, session: data.token };
		},

		async deviceRequest() {
			const response = await request('/api/device/request', { method: 'POST' });
			return response.json() as Promise<DeviceRequestResult>;
		},

		async devicePoll(deviceCode) {
			const response = await request('/api/device/poll', {
				method: 'POST',
				body: JSON.stringify({ deviceCode }),
			});
			return response.json() as Promise<DevicePollResult>;
		},

		async getOrganizations(session) {
			const response = await request('/api/organizations', {
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${session}`,
				},
			});
			return response.json() as Promise<
				Array<{ id: string; name: string; slug: string }>
			>;
		},

		async listProjects(session, orgId) {
			const response = await request(`/api/organizations/${orgId}/projects`, {
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${session}`,
				},
			});
			return response.json() as Promise<
				Array<{ id: string; name: string; slug: string }>
			>;
		},

		async createProject(session, orgId, payload) {
			const response = await request(`/api/organizations/${orgId}/projects`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${session}`,
				},
				body: JSON.stringify(payload),
			});
			return response.json() as Promise<{ id: string }>;
		},

		async getMe(authorization, orgIdHeader) {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Authorization: authorization,
			};
			if (orgIdHeader) {
				headers['X-Poli-Org-Id'] = orgIdHeader;
			}
			const response = await request('/v1/me', {
				method: 'GET',
				headers,
			});
			return response.json() as Promise<MeResponse>;
		},

		async getDocument(authorization, orgIdHeader, id) {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Authorization: authorization,
			};
			if (orgIdHeader) {
				headers['X-Poli-Org-Id'] = orgIdHeader;
			}
			const response = await request(`/v1/documents/${encodeURIComponent(id)}`, {
				method: 'GET',
				headers,
			});
			return response.json() as Promise<DocumentDescriptor>;
		},

		async deleteDocument(authorization, orgIdHeader, id) {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Authorization: authorization,
			};
			if (orgIdHeader) {
				headers['X-Poli-Org-Id'] = orgIdHeader;
			}
			await request(`/v1/documents/${encodeURIComponent(id)}`, {
				method: 'DELETE',
				headers,
			});
		},

		async documentPreview(authorization, orgIdHeader, id) {
			const headers: Record<string, string> = {
				Authorization: authorization,
			};
			if (orgIdHeader) {
				headers['X-Poli-Org-Id'] = orgIdHeader;
			}
			const response = await request(
				`/v1/documents/${encodeURIComponent(id)}/preview`,
				{
					method: 'GET',
					headers,
				}
			);
			const html = await response.text();
			const pageCountHeader = response.headers.get('X-Document-Page-Count');
			const pageCount = pageCountHeader ? Number.parseInt(pageCountHeader, 10) : 0;
			return {
				html,
				pageCount: Number.isFinite(pageCount) ? pageCount : 0,
			};
		},

		async documentThumbnails(authorization, orgIdHeader, id, options) {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Authorization: authorization,
			};
			if (orgIdHeader) {
				headers['X-Poli-Org-Id'] = orgIdHeader;
			}
			const thumbnails: Record<string, unknown> = {};
			if (options.width !== undefined) thumbnails.width = options.width;
			if (options.format !== undefined) thumbnails.format = options.format;
			if (options.quality !== undefined) thumbnails.quality = options.quality;
			if (options.pages !== undefined) thumbnails.pages = options.pages;
			const response = await request(
				`/v1/documents/${encodeURIComponent(id)}/thumbnails`,
				{
					method: 'POST',
					headers,
					body: JSON.stringify({ thumbnails }),
				}
			);
			const data = (await response.json()) as { thumbnails: ThumbnailResult[] };
			return data.thumbnails;
		},

		async render(authorization, orgIdHeader, payload) {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Authorization: authorization,
			};
			if (orgIdHeader) {
				headers['X-Poli-Org-Id'] = orgIdHeader;
			}
			const response = await request('/v1/render', {
				method: 'POST',
				headers,
				body: JSON.stringify(payload),
			});
			return response.json() as Promise<RenderResult>;
		},

		async renderDraft(authorization, orgIdHeader, payload) {
			const response = await request('/v1/render/draft', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: authorization,
					'X-Poli-Org-Id': orgIdHeader,
				},
				body: JSON.stringify(payload),
			});
			return Buffer.from(await response.arrayBuffer());
		},

		async patchFiles(session, orgId, projectId, body) {
			const response = await request(
				`/api/organizations/${orgId}/projects/${projectId}/files`,
				{
					method: 'PATCH',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${session}`,
					},
					body: JSON.stringify(body),
				}
			);
			return response.json() as Promise<PatchFilesResult>;
		},

		async listEnvironments(authorization, orgId) {
			const response = await request(
				`/api/organizations/${idSegment(orgId, 'organization')}/environments`,
				{
					headers: {
						'Content-Type': 'application/json',
						Authorization: authorization,
					},
				}
			);
			return response.json() as Promise<EnvironmentInfo[]>;
		},

		async getProjectEnvironments(session, orgId, projectId) {
			const response = await request(
				`/api/organizations/${idSegment(orgId, 'organization')}/projects/${idSegment(projectId, 'project')}/environments`,
				{
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${session}`,
					},
				}
			);
			return response.json() as Promise<ProjectEnvironmentState[]>;
		},

		async publish(authorization, orgIdHeader, project, body) {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Authorization: authorization,
			};
			if (orgIdHeader) {
				headers['X-Poli-Org-Id'] = orgIdHeader;
			}
			const response = await request(
				`/v1/projects/${encodeURIComponent(project)}/publish`,
				{
					method: 'POST',
					headers,
					body: JSON.stringify(body),
				}
			);
			return response.json() as Promise<PublishResult>;
		},
	};
}

async function buildApiError(response: Response): Promise<ApiError> {
	const text = await response.text();
	const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
	const { code, message } = parseErrorBody(text, response.status);

	const typed = code ? TYPED_ERROR_REGISTRY[code] : undefined;
	if (typed) {
		return new typed(message, retryAfter);
	}

	return new ApiError(code ?? 'UNKNOWN', response.status, message, retryAfter);
}

/**
 * Read the code and a human-readable message from an error response body.
 * Two JSON shapes reach the CLI:
 *
 *  - the API envelope (api-spec §4.1): `{ error: "<CODE>", detail?, issues?, requestId }`.
 *    `detail` is optional: most errors carry only the code.
 *  - Better Auth, for `/api/auth/*` (sign-in, sign-up): `{ code, message }`.
 *
 * Anything else (a non-JSON body, an API Gateway `{ message }`) has no code.
 */
function parseErrorBody(text: string, status: number): { code?: string; message: string } {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return { message: text.trim() === '' ? `HTTP ${status}` : text };
	}
	if (typeof body !== 'object' || body === null) {
		return { message: text };
	}

	const fields = body as Record<string, unknown>;
	const code =
		typeof fields.error === 'string'
			? fields.error
			: typeof fields.code === 'string'
				? fields.code
				: undefined;
	const reason =
		typeof fields.detail === 'string'
			? fields.detail
			: typeof fields.message === 'string'
				? fields.message
				: undefined;
	const issues = formatIssues(fields.issues);

	if (reason !== undefined) {
		return { code, message: issues ? `${reason}: ${issues}` : reason };
	}
	if (code !== undefined) {
		return { code, message: issues ? `${status} ${code}: ${issues}` : `${status} ${code}` };
	}
	return { message: text };
}

/** `{ name: ['Too short'], slug: ['Required'] }` → `name: Too short; slug: Required`. */
function formatIssues(issues: unknown): string | undefined {
	if (typeof issues !== 'object' || issues === null) return undefined;
	const parts = Object.entries(issues as Record<string, unknown>)
		.filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
		.map(([field, messages]) => `${field}: ${messages.map(String).join(', ')}`);
	return parts.length > 0 ? parts.join('; ') : undefined;
}

function parseRetryAfter(header: string | null): number | undefined {
	if (!header) return undefined;
	const seconds = Number.parseInt(header, 10);
	return Number.isFinite(seconds) ? seconds : undefined;
}

function formatNetworkError(url: string, err: TypeError): string {
	const cause = (err as TypeError & { cause?: unknown }).cause;
	const reason = describeCause(cause);
	return `Cannot reach the API.\n  URL:    ${url}\n  Reason: ${reason}`;
}

function describeCause(cause: unknown): string {
	if (!cause) return 'unknown network failure';
	if (cause instanceof Error) {
		const code = (cause as Error & { code?: string }).code;
		return code ? `${cause.message} (${code})` : cause.message;
	}
	return String(cause);
}
