import { describe, it, expect, afterEach } from 'vitest';
import { connect } from 'node:net';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { securityHeaders, startDevServer, type DevServer } from '../src/dev-server.js';

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
	method = 'GET',
	extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
	return new Promise((resolve, reject) => {
		const req = request(
			{ host: '127.0.0.1', port, path, method, headers: { Host: hostHeader, ...extraHeaders } },
			(res) => {
				let body = '';
				res.on('data', (chunk) => {
					body += chunk.toString();
				});
				res.on('end', () =>
					resolve({ status: res.statusCode ?? 0, body, headers: res.headers })
				);
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

	it('rejects a foreign Host even when it names the right port', async () => {
		const { server, handled } = await boot();
		const response = await requestWithHost(server.port, `evil.example:${server.port}`, '/pdf');
		expect(response.status).toBe(403);
		expect(handled).toEqual([]);
	});

	it('rejects the right name on the wrong port, and a missing Host', async () => {
		const { server } = await boot();
		expect((await requestWithHost(server.port, '127.0.0.1:1')).status).toBe(403);

		const noHost = await rawRequest(server.port, 'GET / HTTP/1.0\r\nConnection: close\r\n\r\n');
		expect(noHost).toMatch(/^HTTP\/1\.[01] 403 /);
	});

	it('rejects a rebinding POST that looks same-origin to the fetch metadata', async () => {
		// A rebound page controls both Host and Origin, so the cross-site
		// check alone would pass it: only the Host check, run first, stops it.
		const { server, handled } = await boot();
		const host = `evil.example:${server.port}`;
		const response = await requestWithHost(
			server.port,
			host,
			'/api/select?template=invoice',
			'POST',
			{ 'Sec-Fetch-Site': 'same-origin', Origin: `http://${host}` }
		);
		expect(response.status).toBe(403);
		expect(handled).toEqual([]);
	});

	it('guards the SSE endpoint too', async () => {
		const { server } = await boot();
		const response = await requestWithHost(server.port, 'evil.example', '/events');
		expect(response.status).toBe(403);
	});
});

describe('cross-site requests with a valid Host', () => {
	// Any page on any site can POST to 127.0.0.1 with the right Host: a
	// "simple" request needs no preflight. Only the browser-set fetch
	// metadata tells the dev page's own requests apart.
	async function post(
		server: DevServer,
		headers: Record<string, string>,
		hostName = '127.0.0.1'
	): Promise<number> {
		const response = await requestWithHost(
			server.port,
			`${hostName}:${server.port}`,
			'/api/select?template=invoice',
			'POST',
			headers
		);
		return response.status;
	}

	it('rejects Sec-Fetch-Site: cross-site, same-site and none without running the handler', async () => {
		const { server, handled } = await boot();
		for (const site of ['cross-site', 'same-site', 'none']) {
			expect(await post(server, { 'Sec-Fetch-Site': site, Origin: server.url })).toBe(403);
		}
		expect(handled).toEqual([]);
	});

	it('rejects a foreign Origin when Sec-Fetch-Site is absent', async () => {
		const { server, handled } = await boot();
		for (const origin of [
			'https://evil.example',
			`http://evil.example:${server.port}`,
			`http://localhost:${server.port}`,
			'http://127.0.0.1:1',
			'null',
			'not a url',
		]) {
			expect(await post(server, { Origin: origin })).toBe(403);
		}
		expect(handled).toEqual([]);
	});

	it('rejects a state-changing request that carries neither header', async () => {
		const { server, handled } = await boot();
		expect(await post(server, {})).toBe(403);
		const put = await requestWithHost(server.port, `127.0.0.1:${server.port}`, '/api/pin', 'PUT');
		expect(put.status).toBe(403);
		expect(handled).toEqual([]);
	});

	it("accepts the dev page's own POSTs", async () => {
		const { server, handled } = await boot();
		expect(await post(server, { 'Sec-Fetch-Site': 'same-origin', Origin: server.url })).toBe(200);
		// Browsers without fetch metadata: the Origin decides.
		expect(await post(server, { Origin: server.url })).toBe(200);
		expect(
			await post(server, { Origin: `http://localhost:${server.port}` }, 'localhost')
		).toBe(200);
		expect(handled).toEqual([
			'POST /api/select',
			'POST /api/select',
			'POST /api/select',
		]);
	});

	it('leaves GET and HEAD alone', async () => {
		const { server, handled } = await boot();
		const host = `127.0.0.1:${server.port}`;
		expect((await requestWithHost(server.port, host, '/state', 'GET')).status).toBe(200);
		expect((await requestWithHost(server.port, host, '/state', 'HEAD')).status).toBe(200);
		expect(handled).toEqual(['GET /state', 'HEAD /state']);
	});
});

describe('security headers', () => {
	const expected = {
		'x-frame-options': 'DENY',
		'content-security-policy': "default-src 'self'; frame-src 'self'; frame-ancestors 'none'",
		'x-content-type-options': 'nosniff',
	};

	it('sends them on handled routes, the SSE stream and every rejection', async () => {
		const { server } = await boot();
		const host = `127.0.0.1:${server.port}`;
		const responses = [
			await requestWithHost(server.port, host, '/state'),
			await requestWithHost(server.port, host, '/api/pin', 'POST'),
			await requestWithHost(server.port, 'evil.example', '/'),
		];
		for (const response of responses) expect(response.headers).toMatchObject(expected);

		const controller = new AbortController();
		const events = await fetch(`${server.url}/events`, { signal: controller.signal });
		expect(events.headers.get('content-type')).toMatch(/text\/event-stream/);
		for (const [name, value] of Object.entries(expected)) {
			expect(events.headers.get(name)).toBe(value);
		}
		controller.abort();

		const malformed = await rawRequest(
			server.port,
			`GET http://x:99999999/ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`
		);
		expect(malformed).toMatch(/^X-Frame-Options: DENY\r$/im);
	});

	it('lets a handler loosen framing for a route the page itself frames', async () => {
		const server = await startDevServer({
			port: 0,
			handleRequest: ({ res }) => {
				res.writeHead(200, securityHeaders({ frameable: true }));
				res.end();
			},
		});
		servers.push(server);
		const response = await fetch(`${server.url}/pdf`);
		expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
		expect(response.headers.get('content-security-policy')).toBe(
			"default-src 'self'; frame-src 'self'; frame-ancestors 'self'"
		);
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('allows exactly the inline scripts and styles it is given, by hash', () => {
		const csp = securityHeaders({ inlineScripts: ['alert(1)'], inlineStyles: ['p{}'] })[
			'Content-Security-Policy'
		];
		const hash = (source: string) =>
			`'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;
		expect(csp).toBe(
			"default-src 'self'; frame-src 'self'; frame-ancestors 'none'; " +
				`script-src 'self' ${hash('alert(1)')}; style-src 'self' ${hash('p{}')}`
		);
	});
});
