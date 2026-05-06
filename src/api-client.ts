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
export class PaymentRequiredError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('PAYMENT_REQUIRED', 402, message, retryAfter);
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
export class InvalidVersionFormatError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('INVALID_VERSION_FORMAT', 400, message, retryAfter);
	}
}
export class InvalidVersionForKeyEnvError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('INVALID_VERSION_FOR_KEY_ENV', 400, message, retryAfter);
	}
}
export class VersionRequiredError extends ApiError {
	constructor(message: string, retryAfter?: number) {
		super('VERSION_REQUIRED', 400, message, retryAfter);
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

type TypedErrorCtor = new (message: string, retryAfter?: number) => ApiError;

const TYPED_ERROR_REGISTRY: Record<string, TypedErrorCtor> = {
	QUOTA_EXCEEDED: QuotaExceededError,
	OVERAGE_CAP_EXCEEDED: OverageCapError,
	PAYMENT_REQUIRED: PaymentRequiredError,
	ORGANIZATION_CANCELLED: OrgCancelledError,
	ORGANIZATION_PURGED: OrgPurgedError,
	ORGANIZATION_MIGRATING: OrgMigratingError,
	INVALID_VERSION_FORMAT: InvalidVersionFormatError,
	INVALID_VERSION_FOR_KEY_ENV: InvalidVersionForKeyEnvError,
	VERSION_REQUIRED: VersionRequiredError,
	MISSING_ORG_CONTEXT: MissingOrgContextError,
	NOT_A_MEMBER: NotAMemberError,
	THUMBNAILS_NOT_AVAILABLE: ThumbnailsNotAvailableError,
	DOCUMENT_NOT_FOUND: DocumentNotFoundError,
	DOCUMENT_GONE: DocumentGoneError,
};

export interface ApiKeyInfo {
	key: string;
	info: { id: string; name: string; environment: string };
}

export type VersionState = 'SANDBOX' | 'LIVE' | 'DEPRECATED' | 'DELETED';

export interface VersionInfo {
	id: string;
	version: string;
	major: number;
	minor: number;
	patch: number;
	state: VersionState;
	bumpType?: 'patch' | 'minor' | 'major';
	message?: string;
	pushedBy?: string;
	createdAt: string;
	promotedAt?: string;
	promotedBy?: string;
	unpromotedAt?: string;
	unpromotedBy?: string;
}

export interface PushVersionBody {
	bumpType: 'patch' | 'minor' | 'major';
	message?: string;
}

export interface UnpromotePreview {
	currentLatestLive: string | null;
	newLatestLiveAfterUnpromote: string | null;
	willHaveNoLive: boolean;
	recentLiveCalls: number;
}

export interface ProjectBundle {
	version?: string;
	manifest: Record<string, unknown>;
	templates: Array<{ path: string; content: string }>;
	images?: Array<{ path: string; data: string }>;
	tailwindCss?: string;
}

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

export interface RenderPdfResult {
	pdf: Buffer;
	environment: 'sandbox' | 'live' | null;
}

export interface DocumentDescriptor {
	documentId: string;
	organizationId: string;
	projectId: string | null;
	projectSlug: string | null;
	templateId: string | null;
	templateSlug: string | null;
	version: string;
	environment: 'sandbox' | 'live';
	apiKeyId: string | null;
	createdAt: string;
	pageCount: number;
	sizeBytes: number;
	format: string;
	orientation: string;
	locale: string | null;
	metadata: Record<string, unknown>;
	presignedPdfUrl: string;
	expiresAt: string;
}

export interface MeResponse {
	auth: {
		mode: 'session' | 'api-key';
		keyType: 'test' | 'live' | 'service' | 'session';
		environment: 'sandbox' | 'live' | null;
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
	updateProject(
		session: string,
		orgId: string,
		projectId: string,
		payload: Record<string, unknown>
	): Promise<void>;
	createApiKey(
		session: string,
		orgId: string,
		name: string,
		environment: 'test' | 'live'
	): Promise<ApiKeyInfo>;
	renderPdf(
		authorization: string,
		orgIdHeader: string | undefined,
		payload: Record<string, unknown>
	): Promise<RenderPdfResult>;
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
	pushVersion(
		session: string,
		orgId: string,
		projectId: string,
		body: PushVersionBody
	): Promise<VersionInfo>;
	listVersions(session: string, orgId: string, projectId: string): Promise<VersionInfo[]>;
	promoteVersion(
		session: string,
		orgId: string,
		projectId: string,
		version: string
	): Promise<VersionInfo>;
	unpromoteVersion(
		session: string,
		orgId: string,
		projectId: string,
		version: string,
		body?: { force?: boolean }
	): Promise<VersionInfo>;
	unpromotePreview(
		session: string,
		orgId: string,
		projectId: string,
		version: string
	): Promise<UnpromotePreview>;
	deprecateVersion(
		session: string,
		orgId: string,
		projectId: string,
		version: string
	): Promise<VersionInfo>;
	undeprecateVersion(
		session: string,
		orgId: string,
		projectId: string,
		version: string
	): Promise<VersionInfo>;
	downloadVersion(
		session: string,
		orgId: string,
		projectId: string,
		version: string
	): Promise<ProjectBundle>;
}

export function createApiClient(baseUrl?: string): ApiClient {
	const url = baseUrl ?? process.env.POLI_API_URL ?? DEFAULT_API_URL;

	async function request(path: string, options: RequestInit = {}): Promise<Response> {
		const response = await fetch(`${url}${path}`, {
			...options,
			headers: {
				'Content-Type': 'application/json',
				Origin: url,
				...options.headers,
			},
		});
		if (!response.ok) {
			throw await buildApiError(response);
		}
		return response;
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

		async createApiKey(session, orgId, name, environment) {
			const response = await request(`/api/organizations/${orgId}/api-keys`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${session}`,
				},
				body: JSON.stringify({ name, environment }),
			});
			return response.json() as Promise<ApiKeyInfo>;
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

		async renderPdf(authorization, orgIdHeader, payload) {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Authorization: authorization,
			};
			if (orgIdHeader) {
				headers['X-Poli-Org-Id'] = orgIdHeader;
			}
			const response = await request('/v1/render/pdf', {
				method: 'POST',
				headers,
				body: JSON.stringify(payload),
			});
			const arrayBuffer = await response.arrayBuffer();
			const env = response.headers.get('X-Poli-Environment');
			return {
				pdf: Buffer.from(arrayBuffer),
				environment: env === 'sandbox' || env === 'live' ? env : null,
			};
		},

		async updateProject(session, orgId, projectId, payload) {
			await request(`/api/organizations/${orgId}/projects/${projectId}`, {
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${session}`,
				},
				body: JSON.stringify(payload),
			});
		},

		async pushVersion(session, orgId, projectId, body) {
			const response = await request(
				`/api/organizations/${orgId}/projects/${projectId}/push`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${session}`,
					},
					body: JSON.stringify(body),
				}
			);
			return response.json() as Promise<VersionInfo>;
		},

		async promoteVersion(session, orgId, projectId, version) {
			const response = await request(
				`/api/organizations/${orgId}/projects/${projectId}/versions/${version}/promote`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${session}`,
					},
				}
			);
			return response.json() as Promise<VersionInfo>;
		},

		async unpromoteVersion(session, orgId, projectId, version, body) {
			const response = await request(
				`/api/organizations/${orgId}/projects/${projectId}/versions/${version}/unpromote`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${session}`,
					},
					body: JSON.stringify(body ?? {}),
				}
			);
			return response.json() as Promise<VersionInfo>;
		},

		async unpromotePreview(session, orgId, projectId, version) {
			const response = await request(
				`/api/organizations/${orgId}/projects/${projectId}/versions/${version}/unpromote-preview`,
				{
					method: 'GET',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${session}`,
					},
				}
			);
			return response.json() as Promise<UnpromotePreview>;
		},

		async deprecateVersion(session, orgId, projectId, version) {
			const response = await request(
				`/api/organizations/${orgId}/projects/${projectId}/versions/${version}/deprecate`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${session}`,
					},
				}
			);
			return response.json() as Promise<VersionInfo>;
		},

		async undeprecateVersion(session, orgId, projectId, version) {
			const response = await request(
				`/api/organizations/${orgId}/projects/${projectId}/versions/${version}/un-deprecate`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${session}`,
					},
				}
			);
			return response.json() as Promise<VersionInfo>;
		},

		async listVersions(session, orgId, projectId) {
			const response = await request(
				`/api/organizations/${orgId}/projects/${projectId}/versions`,
				{
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${session}`,
					},
				}
			);
			return response.json() as Promise<VersionInfo[]>;
		},

		async downloadVersion(session, orgId, projectId, version) {
			const response = await request(
				`/api/organizations/${orgId}/projects/${projectId}/versions/${version}/download`,
				{
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${session}`,
					},
				}
			);
			return response.json() as Promise<ProjectBundle>;
		},
	};
}

async function buildApiError(response: Response): Promise<ApiError> {
	const text = await response.text();
	const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));

	let code: string | undefined;
	let message = text;

	try {
		const parsed = JSON.parse(text) as {
			error?: { code?: string; message?: string };
			detail?: string;
			message?: string;
		};
		if (parsed.error?.code) {
			code = parsed.error.code;
			message = parsed.error.message ?? text;
		} else {
			message = parsed.detail ?? parsed.message ?? text;
		}
	} catch {
		// Body is not JSON — fall through with the raw text.
	}

	if (code && TYPED_ERROR_REGISTRY[code]) {
		return new TYPED_ERROR_REGISTRY[code](message, retryAfter);
	}

	return new ApiError(code ?? 'UNKNOWN', response.status, message, retryAfter);
}

function parseRetryAfter(header: string | null): number | undefined {
	if (!header) return undefined;
	const seconds = Number.parseInt(header, 10);
	return Number.isFinite(seconds) ? seconds : undefined;
}
