import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';

/**
 * Loopback only. `poli dev` serves the rendered *draft* of a private
 * project; binding to 0.0.0.0 would publish it to the local network.
 */
export const DEV_SERVER_HOST = '127.0.0.1';

/**
 * Default port for `poli dev`.
 *
 * 7654 is `poli` spelled on a phone keypad (P=7, O=6, L=5, I=4). It sits
 * in the unassigned range, well clear of the ports the popular front-end
 * dev servers grab (3000, 4200, 4321, 5173, 8080), so `poli dev` can run
 * next to them in the same `concurrently` block without a fight. When it
 * is busy anyway the server walks upwards (7655, 7656, …).
 */
export const DEFAULT_DEV_PORT = 7654;

const DEFAULT_PORT_ATTEMPTS = 20;
const SSE_HEARTBEAT_MS = 25_000;

export interface DevServerRequest {
	method: string;
	pathname: string;
	query: URLSearchParams;
	req: IncomingMessage;
	res: ServerResponse;
}

export interface DevServerOptions {
	/** First port to try. Subsequent ports are tried on EADDRINUSE. */
	port?: number;
	maxPortAttempts?: number;
	host?: string;
	/** Path serving the Server-Sent Events stream. */
	eventsPath?: string;
	handleRequest: (request: DevServerRequest) => Promise<void> | void;
}

export interface DevServer {
	readonly port: number;
	readonly url: string;
	/** Number of browsers currently attached to the SSE stream. */
	readonly clientCount: number;
	broadcast(event: string, payload: unknown): void;
	close(): Promise<void>;
}

/**
 * Minimal `node:http` server with a Server-Sent Events channel.
 *
 * Everything except the SSE endpoint is delegated to `handleRequest`;
 * this module owns only the transport concerns — port selection, the
 * event stream, heartbeats, and a shutdown that actually terminates
 * (SSE responses are long-lived, so `server.close()` alone would hang
 * forever waiting for them).
 */
export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
	const host = options.host ?? DEV_SERVER_HOST;
	const eventsPath = options.eventsPath ?? '/events';
	const firstPort = options.port ?? DEFAULT_DEV_PORT;
	const maxAttempts = options.maxPortAttempts ?? DEFAULT_PORT_ATTEMPTS;

	const clients = new Set<ServerResponse>();
	const sockets = new Set<Socket>();
	let closed = false;

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', `http://${host}`);
		if (url.pathname === eventsPath) {
			attachSseClient(req, res);
			return;
		}
		void Promise.resolve(
			options.handleRequest({
				method: (req.method ?? 'GET').toUpperCase(),
				pathname: url.pathname,
				query: url.searchParams,
				req,
				res,
			})
		).catch((err: unknown) => {
			// A handler that throws must not take the process down — the
			// dev server has to survive every failure mode of the loop.
			if (res.headersSent) {
				res.end();
				return;
			}
			const message = err instanceof Error ? err.message : 'Internal error';
			res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify({ error: message }));
		});
	});

	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});

	function attachSseClient(req: IncomingMessage, res: ServerResponse): void {
		res.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			// Disables buffering in any proxy the user might front this with.
			'X-Accel-Buffering': 'no',
		});
		// Ask the browser to back off politely if we go away.
		res.write('retry: 1000\n\n');
		res.write(': connected\n\n');
		clients.add(res);
		const cleanup = () => {
			clients.delete(res);
		};
		req.on('close', cleanup);
		res.on('close', cleanup);
		res.on('error', cleanup);
	}

	const heartbeat = setInterval(() => {
		for (const client of clients) {
			try {
				client.write(': ping\n\n');
			} catch {
				clients.delete(client);
			}
		}
	}, SSE_HEARTBEAT_MS);
	heartbeat.unref?.();

	const port = await listenWithFallback(server, host, firstPort, maxAttempts);

	return {
		port,
		url: `http://${host}:${port}`,
		get clientCount() {
			return clients.size;
		},

		broadcast(event, payload) {
			if (closed) return;
			const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
			for (const client of clients) {
				try {
					client.write(frame);
				} catch {
					clients.delete(client);
				}
			}
		},

		async close() {
			if (closed) return;
			closed = true;
			clearInterval(heartbeat);
			for (const client of clients) {
				try {
					client.end();
				} catch {
					// Already gone — nothing to do.
				}
			}
			clients.clear();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				// Keep-alive sockets would otherwise hold `close()` open.
				for (const socket of sockets) {
					socket.destroy();
				}
				sockets.clear();
			});
		},
	};
}

/**
 * Bind to `port`, walking upwards while the OS reports the address as
 * already in use. Any other listen error is surfaced untouched.
 */
async function listenWithFallback(
	server: Server,
	host: string,
	firstPort: number,
	maxAttempts: number
): Promise<number> {
	let lastError: NodeJS.ErrnoException | null = null;

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const candidate = firstPort === 0 ? 0 : firstPort + attempt;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (err: NodeJS.ErrnoException) => {
					server.removeListener('listening', onListening);
					reject(err);
				};
				const onListening = () => {
					server.removeListener('error', onError);
					resolve();
				};
				server.once('error', onError);
				server.once('listening', onListening);
				server.listen(candidate, host);
			});
			const address = server.address() as AddressInfo | null;
			return address?.port ?? candidate;
		} catch (err) {
			const error = err as NodeJS.ErrnoException;
			if (error.code !== 'EADDRINUSE') throw error;
			lastError = error;
		}
	}

	throw new Error(
		`No free port found in the range ${firstPort}–${firstPort + maxAttempts - 1}. ` +
			`Pass --port <n> to pick another range.` +
			(lastError ? ` (last error: ${lastError.message})` : '')
	);
}
