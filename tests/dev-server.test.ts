import { describe, it, expect, afterEach } from 'vitest';
import { connect } from 'node:net';
import { startDevServer, type DevServer } from '../src/dev-server.js';

let servers: DevServer[] = [];

afterEach(async () => {
	for (const server of servers) await server.close();
	servers = [];
});

async function boot(): Promise<DevServer> {
	const server = await startDevServer({
		port: 0,
		handleRequest: ({ res }) => {
			res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify({ ok: true }));
		},
	});
	servers.push(server);
	return server;
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
		const server = await boot();

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
