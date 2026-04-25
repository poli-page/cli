import type { UserInfo } from './credentials.js';

const DEFAULT_API_URL = 'https://api.poli.page';

export interface ApiKeyInfo {
	key: string;
	info: { id: string; name: string; environment: string };
}

export interface VersionInfo {
	id: string;
	version: string;
	major: number;
	minor: number;
	patch: number;
	createdAt: string;
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
	renderPdf(apiKey: string, payload: Record<string, unknown>): Promise<Buffer>;
	renderThumbnails(
		apiKey: string,
		payload: Record<string, unknown>
	): Promise<ThumbnailResult[]>;
	publishVersion(session: string, orgId: string, projectId: string): Promise<VersionInfo>;
	listVersions(session: string, orgId: string, projectId: string): Promise<VersionInfo[]>;
	downloadVersion(
		session: string,
		orgId: string,
		projectId: string,
		version: string
	): Promise<ProjectBundle>;
}

export function createApiClient(baseUrl?: string): ApiClient {
	const url = baseUrl ?? process.env.POLI_API_URL ?? DEFAULT_API_URL;

	async function request(
		path: string,
		options: RequestInit & { rawResponse?: boolean } = {}
	): Promise<Response> {
		const response = await fetch(`${url}${path}`, {
			...options,
			headers: {
				'Content-Type': 'application/json',
				Origin: url,
				...options.headers,
			},
		});
		if (!response.ok) {
			const body = await response.text();
			let message: string;
			try {
				const json = JSON.parse(body);
				message = json.detail ?? json.message ?? body;
			} catch {
				message = body;
			}
			throw new Error(`API error (${response.status}): ${message}`);
		}
		return response;
	}

	return {
		async signIn(email, password) {
			const response = await request('/api/auth/sign-in/email', {
				method: 'POST',
				body: JSON.stringify({ email, password }),
			});
			const data = await response.json() as { user: UserInfo; token: string };
			return { user: data.user, session: data.token };
		},

		async signUp(email, password, name) {
			const response = await request('/api/auth/sign-up/email', {
				method: 'POST',
				body: JSON.stringify({ email, password, name }),
			});
			const data = await response.json() as { user: UserInfo; token: string };
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
			const response = await request(
				`/api/organizations/${orgId}/projects`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${session}`,
					},
					body: JSON.stringify(payload),
				}
			);
			return response.json() as Promise<{ id: string }>;
		},

		async createApiKey(session, orgId, name, environment) {
			const response = await request(
				`/api/organizations/${orgId}/api-keys`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${session}`,
					},
					body: JSON.stringify({ name, environment }),
				}
			);
			return response.json() as Promise<ApiKeyInfo>;
		},

		async renderPdf(apiKey, payload) {
			const response = await request('/v1/render/pdf', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(payload),
			});
			const arrayBuffer = await response.arrayBuffer();
			return Buffer.from(arrayBuffer);
		},

		async renderThumbnails(apiKey, payload) {
			const response = await request('/v1/render/thumbnails', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(payload),
			});
			const data = (await response.json()) as { thumbnails: ThumbnailResult[] };
			return data.thumbnails;
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

		async publishVersion(session, orgId, projectId) {
			const response = await request(
				`/api/organizations/${orgId}/projects/${projectId}/publish`,
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
