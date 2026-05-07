# Changelog

All notable changes to `@poli-page/cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] — 2026-05-07

API surface stabilisation. The server now uniformly returns a JSON
descriptor for every render (no more PDF binary), and the CLI follows.

### Changed (BREAKING)
- **`poli render` now talks to `POST /v1/render`**, the new unified
  render endpoint (api-spec §11.3). The previous `/v1/render/pdf`
  (binary) and `/v1/render/document` are retired (404).
- **The render result is the JSON descriptor**, not a PDF buffer.
  `executeRender` returns `{ descriptor, outputPath? }` instead of
  `{ outputPath, version, environment }`. The descriptor carries 16
  fields incl. `documentId`, `presignedPdfUrl`, `expiresAt`, `pageCount`,
  `sizeBytes`, `metadata`. This unblocks chaining: every render now
  produces a `documentId` you can pass to `poli documents thumbnails`,
  `poli documents preview`, or `poli documents get`.
- **Default download path is `output/<templateSlug>/<templateSlug>.pdf`**
  (one folder per template). The CLI fetches the `presignedPdfUrl` and
  writes the file locally — same UX as before, just via S3.
- **The JSON descriptor is always printed to stdout** (whether the PDF
  was downloaded or not). The success line goes to stderr so pipelines
  can `jq` the JSON cleanly.
- **`api-client.renderPdf` → `render`.** Returns `RenderResult` (alias
  of `DocumentDescriptor`) instead of `{ pdf: Buffer, environment }`.

### Added
- **`--no-download` flag** for `poli render` — skips the presigned URL
  fetch entirely, only emits the JSON descriptor. Useful for CI/CD
  pipelines that consume the metadata and let a downstream step fetch
  the PDF (the URL is valid 15 min per api-spec §11.3).
- **`fetchPdf` injection** on `executeRender` for testability.

### Removed
- `poli render document` was never actually shipped as a command (only
  in older spec drafts) — explicitly out of scope. `/v1/render/document`
  is retired upstream; everything goes through `poli render`.
- `RenderPdfResult` interface (replaced by `RenderResult`).

### Fixed
- **`poli render` was discarding the `locale` field from the mock JSON.**
  `loadTemplate` already extracted it (e.g. `"locale": "en"` from
  `templates/<name>/<name>.json`) but `executeRender` ignored it and
  never sent it to the API. Templates that depend on date or number
  formatting tied to a locale were silently rendering with the engine
  default instead of the declared locale. Now forwarded in the payload
  when defined; omitted entirely when the mock or `--data` file is flat
  or has no `locale` field. `--data` fully replaces both `data` and
  `locale` (same precedence as before, just with the locale carried).
- **`poli render --data <file>` was double-wrapping the payload when the
  file used the same `{ locale, data: { … } }` shape as the mock JSON
  scaffolded by `poli init`.** The on-disk mock file is auto-dewrapped
  by `loadTemplate`, but the `--data` override read the file raw and
  passed the whole object through, which then arrived at the engine as
  `{ data: { data: {...} } }` — so any `{{ title }}` reference rendered
  empty. The dewrap is now factored into a shared `unwrapMockJson`
  helper and applied to both paths. Flat-shape `--data` files keep
  working unchanged.
- **`poli link` was sending the wrong payload to `POST /api/organizations/:orgId/projects`.**
  The body used to be `{ name, slug }`, but the API's Zod schema (`createProjectSchema`)
  expects `{ manifest, templates, images?, tailwindCss? }` — the same shape `poli push`
  uses for `updateProject`. Linking now goes through `collectProjectPayload(cwd, manifest)`
  and creates the cloud project with the local content as initial state. Fixes a
  `ZodError: expected object, received undefined` failure on every fresh link.
- **`poli link` left its `Linking project…` spinner running after an API error.**
  The `ora` spinner is now correctly transitioned to a failed state in the catch
  block, so the terminal does not hang.

## [0.5.0] — 2026-05-07

### Added
- **Interactive starter prompt for `poli init`** — when `--with-template`
  is not passed and the shell is interactive, the CLI now asks
  *"Add a starter template?"* (y/N). On yes, it lists the available
  collections from the source repo's `index.json` (with descriptions),
  then the templates within the chosen collection (also with
  descriptions), then asks for the destination template name in the
  project (default = source template name; the user can keep it or
  rename). Skipped silently in non-TTY contexts (CI). Network failure
  during the prompt does **not** leave a half-created project on disk
  — the prompt runs before scaffolding.
- **Interactive prompt for `poli new`** — same picker, triggered when
  `--from-template` is omitted in an interactive shell. Non-TTY without
  the flag still throws the friendly "Missing --from-template" error.
- New public export `fetchTemplateIndex(source, options)` from
  `template-importer.ts` — used by the prompt module to fetch and
  parse `index.json` without going through the full import pipeline.
- New module `src/template-prompt.ts` exposing
  `promptForStarterTemplate({ isTTY, confirmFn, selectFn, inputFn,
  fetchIndex, promptDestName, … })` for direct programmatic use or
  testing. Returns `{ ref, destName? } | null`. The optional
  `promptDestName` flag (used by `init`, not by `new`) appends an
  input prompt for the destination template name. Precedence on the
  destination name is: `--template-name` flag > prompt's `destName`
  > source template's own name.

### Changed
- `--from-template` is no longer a `requiredOption` on `poli new` —
  it's now optional. The interactive prompt is the alternate path.
- `poli init` and `poli new` no longer wrap their work in an `ora`
  spinner. The spinner clobbered the interactive prompt's rendering;
  a plain `✓` line on success is cleaner.

[0.5.0]: https://github.com/poli-page/cli/compare/v0.4.1...v0.5.0

## [0.4.1] — 2026-05-07

UX patch built from real-world testing of 0.4.0. Three fixes that
made the CLI hard to use against the develop environment.

### Changed
- **Network errors now show what failed.** Node's fetch surfaces low-level
  network failures as `TypeError: fetch failed`, hiding the real cause.
  The CLI now unwraps the `cause` and prints the URL that was tried plus
  the underlying reason (e.g. `getaddrinfo ENOTFOUND api-develop.poli.page`).
- **`poli whoami` now works from anywhere.** Previously, in session mode,
  it required a linked project (because `/v1/me` needs `X-Poli-Org-Id`).
  When called outside a linked project, it now falls back to listing the
  organizations the session can see — like `gh auth status`. The new mode
  is exposed as `mode: 'session-no-org'` in `--json` output.

### Fixed
- **`--api-url` is now persisted at login.** The flag value is now
  injected into `executeDeviceLogin` directly (in addition to the
  pre-existing `POLI_API_URL` env var path), so it lands in
  `~/.polipage/credentials.json` after a successful device flow.
  Subsequent commands no longer need `--api-url` repeated.

[0.4.1]: https://github.com/poli-page/cli/compare/v0.4.0...v0.4.1

## [0.4.0] — 2026-05-06

Synced with the monorepo's 0.4.0 release. Big surface expansion: the
documents namespace, `poli watch`, exit-code centralisation, CI/CD
auth improvements.

### Added
- `poli watch` — auto-sync the local project to the cloud draft on each save
  (debounced 2s). The flow that turns the dashboard "quickstart loop" from a
  copy-paste demo into a live feedback loop: edit locally → save → the next
  `curl` from the dashboard reflects the change within seconds.
  - File watching via `chokidar` v5 (default ignore: `node_modules/`, `.git/`,
    `output/`, `dist/`, `*.log`, `.DS_Store`).
  - Incremental sync via `PATCH /api/organizations/:orgId/projects/:projectId/files`
    with a `Map<path, sha256>` content-hash diff — only changed bytes are
    uploaded.
  - Resilience: exponential backoff on network errors (1s, 2s, 4s, 8s, 16s,
    capped at 30s); `503 ORGANIZATION_MIGRATING` triggers a 5-second retry.
  - Friendly translation of `403 SYSTEM_PROJECT_LOCKED` for the
    `getting-started` system project.
  - Requires a TTY (refused with exit 2 in non-interactive contexts).
  - **Out of scope for this version**: the local HTTP preview server +
    WebSocket auto-reload (`--port`, `--no-open`, `--engine`) listed in
    cli-spec.md §5 — to be scoped separately.
- Typed errors `SystemProjectLockedError` (403) and `SystemProjectImmutableError`
  (403) added to the api-client error registry.
- `api-client.patchFiles(session, orgId, projectId, body)` — wraps
  `PATCH /api/organizations/:orgId/projects/:projectId/files`.
- `poli documents get <id>` — fetch a document descriptor (metadata + 15-minute
  presigned PDF URL). Calls `GET /v1/documents/:id` over hybrid auth (session
  or `pp_*` API key). The CLI does not download the PDF — the presigned URL
  is the contract. `--json` dumps the full descriptor.
- `poli documents delete <id>` — soft-delete a document. Idempotent: returns
  success even if the document was already deleted. `--yes` skips the prompt.
- `poli documents thumbnails <id>` — regenerate thumbnails on demand from a
  stored document via `POST /v1/documents/:id/thumbnails`. Counts as one
  billable render against the monthly PDF quota when the auth env is `live`.
  Free tier returns `403 THUMBNAILS_NOT_AVAILABLE`. Flags: `--width`,
  `--format png|jpeg`, `--quality`, `--pages 1,3`, `-o <dir>`, `--json`.
- `poli documents preview <id>` — fetch the stored canonical HTML re-wrapped
  as preview-mode (free, no quota cost). Default writes to
  `./output/documents/<id>.preview.html` and opens the browser. `--no-open`,
  `-o <file>`, `--json` available.
- Typed errors `ThumbnailsNotAvailableError` (403), `DocumentNotFoundError`
  (404), `DocumentGoneError` (410) added to the api-client error registry.

### Changed
- **BREAKING** — `poli thumbnail` now takes a `<documentId>` argument and
  forwards to `poli documents thumbnails`. The previous local-mode rendering
  path was removed: the CLI no longer bundles the engine. Generate the
  document with `poli render document <name>` first (it returns the
  documentId), then thumbnail it. The `--live` and `--remote` flags are gone;
  env is implicit in the auth context.

### Removed
- `api-client.renderThumbnails` — `/v1/render/thumbnails` was retired
  upstream (api-spec §11.4). Thumbnails now flow through `documentThumbnails`
  against a stored document, which guarantees zero drift with the source PDF.

### CI / CD
- `poli login` now prints a non-blocking info-message when
  `POLI_PAGE_API_KEY` is set in the environment, then proceeds with the
  device flow. After login, the stored session takes precedence over the
  env var (CLI-S08 precedence rule).
- New `tests/ci-api-key.test.ts` covers the `pp_sa_*` end-to-end CI path
  (resolver, `pp_*` validation, header propagation, session > env var
  precedence).

### Internal
- New `src/exit-codes.ts` — centralises the cli-spec §1.2 table (0/1/2/3/4/5/6)
  and exposes `errorToExitCode(err)` to map thrown values to a code via the
  typed-error registry. All command handlers now route through it instead of
  hardcoding `process.exitCode = 1`. This means commands like `poli render`
  on a free-tier org now exit `5` (`NOT_AUTHORIZED`) instead of `1`, and
  `poli render` on an unlinked folder exits `6` (`INVALID_LOCAL_STATE`).
- New CI workflows: `.github/workflows/ci.yml` (typecheck + test + build on
  every push and PR) and `.github/workflows/release.yml` (npm publish on
  `v*` tags, with a tag/version match guard).

[0.4.0]: https://github.com/poli-page/cli/compare/v0.1.2...v0.4.0

## [0.1.2] — 2026-04-26

### Changed
- Bumped minimum required Node.js version from `>=22.0.0` to `>=22.13.0`.
  Aligns the declared engine with the actual requirement of
  `@inquirer/prompts@8.4.2`, which needs Node `^22.13.0` (or newer LTS
  branches). Users on Node 22.12 or earlier will now get a clear engine
  warning at install time instead of cascading dependency warnings.

## [0.1.1] — 2026-04-26

### Fixed
- `poli init` now scaffolds `partials/`, `assets/fonts/`, and `assets/images/`
  directories alongside the existing `templates/` and `assets/`. Aligns the
  scaffolded layout with the standard project structure used by the editor.

## [0.1.0] — 2026-04-25

### Added
- Initial public release on npm under the `@poli-page` scope.
- `poli init` — scaffold a new project with manifest, `tailwind.css`, and
  standard directories.
- `poli new` — create templates from one of six layout models (blank,
  header-main-footer, header-sidebar-main-footer, header-main-sidebar-footer,
  sidebar-header-main-footer, header-main-footer-sidebar).
- `poli render` — render a template to PDF locally or via the cloud API.
- `poli login` / `poli logout` / `poli whoami` — device authorization flow
  authentication, credentials stored in `~/.poli-page/credentials.json`.
- `poli link` / `poli unlink` — associate a local project with a cloud
  organization.
- `poli publish` — sync a local project and publish a new version.
- `poli versions list` / `poli versions download` — manage published versions.
- `poli thumbnail` — generate page thumbnail images via the cloud API.

[Unreleased]: https://github.com/poli-page/cli/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/poli-page/cli/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/poli-page/cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/poli-page/cli/releases/tag/v0.1.0
