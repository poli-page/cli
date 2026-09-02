/**
 * The `poli dev` shell page.
 *
 * Static by construction: it carries no server data at all and pulls
 * everything from `GET /state` plus the `/events` SSE stream. That keeps
 * the document free of interpolation (nothing to escape, nothing to
 * inject) and lets the rendered template live in an isolated iframe, so
 * a reload swaps the frame without losing the switcher, the pin, or the
 * scroll position of the chrome.
 */
export const DEV_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>poli dev</title>
<style>
	:root {
		color-scheme: light dark;
		--bg: #f4f4f5;
		--chrome: #ffffff;
		--fg: #18181b;
		--muted: #71717a;
		--border: #e4e4e7;
		--accent: #4f46e5;
		--danger: #dc2626;
		--ok: #16a34a;
	}
	@media (prefers-color-scheme: dark) {
		:root {
			--bg: #18181b;
			--chrome: #0f0f11;
			--fg: #fafafa;
			--muted: #a1a1aa;
			--border: #27272a;
			--accent: #818cf8;
			--danger: #f87171;
			--ok: #4ade80;
		}
	}
	* { box-sizing: border-box; }
	html, body { height: 100%; }
	body {
		margin: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg);
		color: var(--fg);
		font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	}
	header {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		padding: 8px 12px;
		background: var(--chrome);
		border-bottom: 1px solid var(--border);
	}
	.brand { font-weight: 600; letter-spacing: -0.01em; }
	.brand small { color: var(--muted); font-weight: 400; margin-left: 4px; }
	select, button {
		font: inherit;
		color: inherit;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 4px 8px;
		cursor: pointer;
	}
	button:hover, select:hover { border-color: var(--accent); }
	button[disabled] { opacity: 0.5; cursor: default; }
	button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
	.spacer { flex: 1; }
	.status { color: var(--muted); display: flex; align-items: center; gap: 6px; }
	.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
	.dot.busy { background: var(--accent); animation: pulse 1s ease-in-out infinite; }
	.dot.ok { background: var(--ok); }
	.dot.bad { background: var(--danger); }
	@keyframes pulse { 50% { opacity: 0.25; } }
	.stage { position: relative; flex: 1; min-height: 0; }
	iframe { width: 100%; height: 100%; border: 0; background: #fff; }
	.badge {
		position: absolute;
		left: 50%;
		bottom: 16px;
		transform: translateX(-50%);
		background: var(--accent);
		color: #fff;
		border: 0;
		border-radius: 999px;
		padding: 6px 14px;
		box-shadow: 0 6px 20px rgba(0,0,0,0.25);
	}
	.overlay {
		position: absolute;
		inset: 0;
		padding: 24px;
		overflow: auto;
		background: color-mix(in srgb, var(--bg) 88%, transparent);
		backdrop-filter: blur(2px);
	}
	.overlay-card {
		max-width: 900px;
		margin: 0 auto;
		background: var(--chrome);
		border: 1px solid var(--danger);
		border-radius: 10px;
		padding: 18px 20px;
	}
	.overlay h2 { margin: 0 0 4px; font-size: 14px; color: var(--danger); }
	.overlay .where { color: var(--muted); font-family: ui-monospace, SFMono-Regular, monospace; }
	.overlay pre {
		margin: 12px 0 0;
		white-space: pre-wrap;
		word-break: break-word;
		font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.overlay .hint { margin-top: 12px; color: var(--muted); }
	[hidden] { display: none !important; }
</style>
</head>
<body>
<header>
	<span class="brand">poli dev<small id="pages"></small></span>
	<label class="visually-hidden" for="template" hidden>Template</label>
	<select id="template" title="Template shown in the preview"></select>
	<button id="pin" aria-pressed="false" title="Freeze the view on this template — saves elsewhere will not switch it">Pin</button>
	<button id="pdf" title="Render the real PDF for this template">Render PDF</button>
	<button id="live" hidden title="Go back to the live HTML preview">Live preview</button>
	<span class="spacer"></span>
	<span class="status"><span class="dot" id="dot"></span><span id="statusText">connecting…</span></span>
</header>
<div class="stage">
	<iframe id="frame" src="/preview" title="Rendered document"></iframe>
	<button class="badge" id="newRender" hidden>New render available — show live preview</button>
	<div class="overlay" id="overlay" hidden>
		<div class="overlay-card">
			<h2 id="errTitle">Render failed</h2>
			<div class="where" id="errWhere"></div>
			<pre id="errMessage"></pre>
			<div class="hint">The last good render is still behind this overlay. Fix the file and save — the overlay clears on the next successful render.</div>
		</div>
	</div>
</div>
<script>
(function () {
	var frame = document.getElementById('frame');
	var select = document.getElementById('template');
	var pinBtn = document.getElementById('pin');
	var pdfBtn = document.getElementById('pdf');
	var liveBtn = document.getElementById('live');
	var newRenderBtn = document.getElementById('newRender');
	var overlay = document.getElementById('overlay');
	var errTitle = document.getElementById('errTitle');
	var errWhere = document.getElementById('errWhere');
	var errMessage = document.getElementById('errMessage');
	var statusText = document.getElementById('statusText');
	var dot = document.getElementById('dot');
	var pages = document.getElementById('pages');

	var shownVersion = -1;
	var latestVersion = -1;
	var mode = 'preview';
	// Optimistic: the very first /state fetch races the EventSource open
	// event, and a one-frame "disconnected" flash would be a lie.
	var connected = true;

	function showPreview(version) {
		mode = 'preview';
		shownVersion = version;
		liveBtn.hidden = true;
		newRenderBtn.hidden = true;
		frame.src = '/preview?v=' + version;
	}

	function apply(state) {
		latestVersion = state.renderVersion;

		if (state.templates.join('\\u0000') !== Array.prototype.map.call(select.options, function (o) { return o.value; }).join('\\u0000')) {
			select.textContent = '';
			state.templates.forEach(function (name) {
				var option = document.createElement('option');
				option.value = name;
				option.textContent = name;
				select.appendChild(option);
			});
		}
		if (state.activeTemplate) select.value = state.activeTemplate;
		select.disabled = state.templates.length === 0;

		pinBtn.setAttribute('aria-pressed', state.pinned ? 'true' : 'false');
		pinBtn.textContent = state.pinned ? 'Pinned' : 'Pin';
		pinBtn.title = state.pinned
			? 'Pinned to ' + (state.activeTemplate || 'this template') + ' — click to follow the most recently changed template again'
			: 'Following the most recently changed template — click to freeze this one';

		pages.textContent = state.pageCount ? ' · ' + state.pageCount + (state.pageCount === 1 ? ' page' : ' pages') : '';

		if (state.error) {
			errTitle.textContent = state.error.stage === 'sync' ? 'Sync failed' : 'Render failed';
			var where = '';
			if (state.error.file) {
				where = state.error.file;
				if (state.error.line) {
					where += ':' + state.error.line;
					if (state.error.column) where += ':' + state.error.column;
				}
			}
			errWhere.textContent = where;
			errWhere.hidden = where === '';
			errMessage.textContent = state.error.message;
			overlay.hidden = false;
		} else {
			overlay.hidden = true;
		}

		if (!connected) {
			setStatus('bad', 'disconnected');
		} else if (state.status === 'syncing') {
			setStatus('busy', 'syncing…');
		} else if (state.status === 'rendering') {
			setStatus('busy', 'rendering ' + (state.activeTemplate || '') + '…');
		} else if (state.error) {
			setStatus('bad', 'error');
		} else {
			setStatus('ok', state.lastRenderedAt ? 'rendered ' + new Date(state.lastRenderedAt).toLocaleTimeString() : 'idle');
		}

		if (state.renderVersion > 0 && state.renderVersion !== shownVersion) {
			if (mode === 'preview') showPreview(state.renderVersion);
			else newRenderBtn.hidden = false;
		}
	}

	function setStatus(kind, text) {
		dot.className = 'dot ' + kind;
		statusText.textContent = text;
	}

	function post(path) {
		return fetch(path, { method: 'POST' }).then(function (r) { return r.json(); });
	}

	function refresh() {
		return fetch('/state').then(function (r) { return r.json(); }).then(apply);
	}

	select.addEventListener('change', function () {
		post('/api/select?template=' + encodeURIComponent(select.value)).then(function (s) {
			mode = 'preview';
			apply(s);
		});
	});

	pinBtn.addEventListener('click', function () {
		var next = pinBtn.getAttribute('aria-pressed') !== 'true';
		post('/api/pin?value=' + (next ? 'true' : 'false')).then(apply);
	});

	pdfBtn.addEventListener('click', function () {
		pdfBtn.disabled = true;
		var previous = pdfBtn.textContent;
		pdfBtn.textContent = 'Rendering PDF…';
		post('/api/pdf')
			.then(function (result) {
				if (result && result.url) {
					mode = 'pdf';
					frame.src = result.url;
					liveBtn.hidden = false;
					newRenderBtn.hidden = true;
				}
				return refresh();
			})
			.finally(function () {
				pdfBtn.disabled = false;
				pdfBtn.textContent = previous;
			});
	});

	liveBtn.addEventListener('click', function () { showPreview(latestVersion); });
	newRenderBtn.addEventListener('click', function () { showPreview(latestVersion); });

	var source = new EventSource('/events');
	source.addEventListener('state', function (event) { apply(JSON.parse(event.data)); });
	source.addEventListener('open', function () {
		connected = true;
		refresh();
	});
	source.addEventListener('error', function () {
		connected = false;
		setStatus('bad', 'disconnected — is poli dev still running?');
	});

	refresh();
})();
</script>
</body>
</html>
`;

/** Placeholder served on `/preview` before the first successful render. */
export const DEV_PLACEHOLDER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>poli dev</title>
<style>
	body { margin: 0; height: 100vh; display: grid; place-items: center;
		font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; color: #71717a; background: #fff; }
</style>
</head><body><p>Waiting for the first render…</p></body></html>
`;
