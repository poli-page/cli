import { describe, it, expect, afterEach } from 'vitest';
import { connect } from 'node:net';
import { request } from 'node:http';
import { startDevServer, type DevServer } from '../src/dev-server.js';

let servers: DevServer[] = [];

afterEach(async () => {
	for (const server of servers) await server.close();
	servers = [];
});

async function boot(): Promise<{ server: DevServer; handled: string[] }> {
	const handled: string[] = [];
	const server = await startDevServer({
		port: 0,
		handleRequest: ({ method, pathname, res }) => {
			handled.push(`${method} ${pathname}`);
			res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify({ ok: true }));
		},
	});
	servers.push(server);
	return { server, handled };
}

/**
 * `fetch()` cannot produce an absolute-form request target or a forged
 * Host header, so these tests write the request head over a raw socket
 * and read whatever comes back.
 */
function rawRequest(port: number, head: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, '127.0.0.1');
		let data = '';
		socket.on('data', (chunk) => {
			data += chunk.toString();
		});
		socket.on('end', () => resolve(data));
		socket.on('close', () => resolve(data));
		socket.on('error', reject);
		socket.on('connect', () => socket.write(head));
	});
}

describe('malformed request URLs', () => {
	it('answers 400 to an absolute-form target the URL parser rejects — and survives', async () => {
		const { server } = await boot();

		// The WHATWG parser throws on this port; the process must not die.
		const response = await rawRequest(
			server.port,
			`GET http://x:99999999/ HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`
		);
		expect(response).toMatch(/^HTTP\/1\.1 400 /);

		// The server is still up and serving normal requests.
		const ok = await fetch(`${server.url}/after`);
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ ok: true });
	});
});

/** `node:http` (unlike fetch) lets a test forge the Host header. */
function requestWithHost(
	port: number,
	hostHeader: string,
	path = '/',
	method = 'GET'
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request(
			{ host: '127.0.0.1', port, path, method, headers: { Host: hostHeader } },
			(res) => {
				let body = '';
				res.on('data', (chunk) => {
					body += chunk.toString();
				});
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
			}
		);
		req.on('error', reject);
		req.end();
	});
}

describe('Host validation', () => {
	it('accepts the hosts a legitimate browser sends', async () => {
		const { server } = await boot();
		for (const name of ['127.0.0.1', 'localhost']) {
			const response = await requestWithHost(server.port, `${name}:${server.port}`);
			expect(response.status).toBe(200);
		}
		// fetch() sends the canonical Host itself — the normal page flow.
		expect((await fetch(`${server.url}/state`)).status).toBe(200);
	});

	it('rejects a state-changing POST carrying a foreign Host (CSRF / rebinding)', async () => {
		const { server, handled } = await boot();
		const response = await requestWithHost(
			server.port,
			'evil.example',
			'/api/pdf',
			'POST'
		);
		expect(response.status).toBe(403);
		// The handler never ran — no PDF render was triggered.
		expect(handled).toEqual([]);
	});

	it('rejects a foreign Host even when it names the right port', async () => {
		const { server, handled } = await boot();
		const response = await requestWithHost(
			server.port,
			`evil.example:${server.port}`,
			'/preview'
		);
		expect(response.status).toBe(403);
		expect(handled).toEqual([]);
	});

	it('rejects the right name on the wrong port, and a missing Host', async () => {
		const { server } = await boot();
		expect((await requestWithHost(server.port, '127.0.0.1:1')).status).toBe(403);

		const noHost = await rawRequest(
			server.port,
			'GET / HTTP/1.0\r\nConnection: close\r\n\r\n'
		);
		expect(noHost).toMatch(/^HTTP\/1\.[01] 403 /);
	});

	it('guards the SSE endpoint too', async () => {
		const { server } = await boot();
		const response = await requestWithHost(server.port, 'evil.example', '/events');
		expect(response.status).toBe(403);
	});
});
