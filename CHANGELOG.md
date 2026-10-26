# Changelog

All notable changes to `@poli-page/cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **New command `poli publish --env <name> [-m, --message <text>] [-y, --yes] [--json]`** publishes the local project (the files on disk, not the cloud draft) to an environment of your organization through `POST /v1/projects/<projectSlug>/publish`, with your `poli login` session and the manifest's `cloud.orgId`. The environment's copy is replaced in place; there is no rollback. `--env` is required, has no default, and is checked before any call: 1-20 characters, lowercase letters, digits and single inner hyphens, starting with a letter; `draft` is refused. An environment the organization does not have is refused with the list of the ones it has. A message over 500 characters or a bundle over 5 MiB is refused locally (exit `2`). Publishing to a protected environment (`live` by default) asks for confirmation in a terminal; without a TTY it needs `--yes`, and `CI=true` counts as `--yes`. Errors: `ENVIRONMENT_PROTECTED` exits `5` (an owner or admin is required), `ENVIRONMENT_NOT_FOUND` and `UNSUPPORTED_FILE_TYPE` exit `2`, `PUBLISH_IN_PROGRESS` exits `3` and is not retried. On success it prints the environment, project, short bundle hash, file count and publish log id (`--json`, or a pipe, prints the API response). `ApiClient` gains `publish()` and `listEnvironments()`, and the typed errors `EnvironmentProtectedError`, `EnvironmentNotFoundError` and `UnsupportedFileTypeError`.

### Changed
- **`poli dev` renders the draft to PDF through `POST /v1/render/draft`, with your signed-in session.** The API removed `POST /v1/render/preview` and no longer accepts `version: 'draft'` on `POST /v1/render`, so `poli dev` could not render at all. Every render is now the real PDF of the draft: the page shows it in the browser's PDF viewer and reloads it after each successful sync or template switch. Draft renders are session-only, unwatermarked, never stored and never counted, so `poli dev` creates no document; `POLI_PAGE_API_KEY` plays no part, since an API key cannot render the draft. The **Render PDF** and **Live preview** buttons, the page-count badge, the `POST /api/pdf` and `GET /pdf/:id` routes and the `/preview` route are gone; the page loads the last good PDF from `GET /pdf`, and `DevState` no longer carries `pageCount`. The template switcher, pin, error overlay (the last good PDF stays behind it) and the stale-render guard are unchanged, and so is `poli watch`. A PDF render takes longer than the old HTML preview. `ApiClient.renderDraft()` is added and returns the PDF as a `Buffer`.
- **The next steps of `poli init --starter`** suggest `poli publish --env sandbox` instead of `poli push`.

### Removed (BREAKING)
- **`poli push`, `poli promote`, `poli unpromote`, `poli versions list`, `poli versions deprecate` and `poli versions un-deprecate` are removed.** The API no longer has versions: the push and version routes are gone, and every one of these commands got `404`. `poli publish --env <name>` replaces them: one in-place publish per environment, with no version numbers, no promotion and no version states. There is no rollback; to undo a bad publish, publish an earlier state from your own version control.
- **`poli preview` is removed.** The API removed `POST /v1/render/preview`, and there is no authenticated HTML preview any more. Use `poli dev` to see the draft as a PDF while you edit. `poli documents preview <id>` stays: it reads a stored document's HTML.
- **`ApiClient` drops `pushVersion`, `listVersions`, `promoteVersion`, `unpromoteVersion`, `unpromotePreview`, `deprecateVersion`, `undeprecateVersion`, `updateProject` and `renderPreview`,** with the types `VersionState`, `VersionInfo`, `PushVersionBody`, `UnpromotePreview` and `PreviewApiResult`, and `validateExactSemver` / `EXACT_SEMVER` leave `src/cloud-context.ts`.
- **The error classes `InvalidVersionFormatError`, `InvalidVersionForKeyEnvError`, `VersionRequiredError`, `InvalidTrackFormatError`, `VersionConflictError`, `SystemProjectLockedError` and `SystemProjectImmutableError` are removed,** with their exit-code mappings. The API no longer sends these codes; should one arrive, it is a generic `ApiError` (exit `3`). `getting-started` is an ordinary project, so there is no system project to lock.

### Fixed
- **The draft sync of `poli watch` and `poli dev` failed on every save with `400 VALIDATION_ERROR`.** The API now requires an `encoding` on every added and modified file of `PATCH …/projects/:projectId/files`, and the CLI sent `{ path, content }` only. Each entry is now `{ path, encoding, content }`: `base64` for the files under `assets/`, `utf8` for the rest. The wire type `PatchFilesEntry` is renamed `ProjectFileEntry`, and `isBinaryAsset` is replaced by `projectFileEncoding` (`src/project-files.ts`).
- **The draft sync now uses the API's file set, shared with `poli publish`:** `poli-page.json`, `tailwind.css`, `.html`/`.json`/`.css` files under `templates/<slug>/`, `.html` files under `partials/`, any file under `assets/images/` and `assets/icons/`, and font files under `assets/fonts/`. A `.css` file under `templates/<slug>/` (such as `tailwind-additions.css`) is now synced; an `.html` or `.json` file outside those folders, or an image outside `assets/`, is no longer tracked, since the API refuses it with `400 UNSUPPORTED_FILE_TYPE` and fails the whole batch.

## [0.9.0] — 2026-10-18

### Added
- **`poli init --starter getting-started [dir]`** writes the `getting-started/` project of `poli-page/templates` (templates, mocks, `poli-page.json`, `tailwind.css`, fonts, images) into `dir` (default `./getting-started`) and, when you are logged in, links it to your organization's **existing** `getting-started` cloud project (found by slug; `--org <slug>` picks the organization when you belong to several). It never creates a cloud project and downloads nothing from the cloud. Logged out, or when the organization has no such project, the starter is written unlinked with the steps to link it. The written manifest has no `project.version`. A non-empty target directory is refused unless `--force`. The file list is read from the templates repo's git tree (one GitHub API call). The `<name>` argument of `poli init` is now optional with `--starter`. `<name>` is one top-level folder of the templates repo (no `/`). Piped or with `--json`, it prints `{ starter, projectDir, link }` as JSON and never prompts for the organization.
- **New command `poli dev [template]`** — a live-reloading preview server for template authors, and the code-first alternative to the desktop editor. It watches the project, syncs each save to the cloud draft (the same delta sync `poli watch` performs), re-renders the active template through `POST /v1/render/preview`, and pushes a reload to connected browsers over Server-Sent Events. Rendering is driven by the sync-completed event — there is no polling and no guessed delay. The served page (default `http://127.0.0.1:7654`, `--port` to change, auto-incremented when busy) carries a template switcher that follows the most recently changed template, a **pin** control that freezes the view so an unrelated save cannot yank it away, a **Render PDF** action that runs the real `POST /v1/render` and displays the resulting PDF inline, and an error overlay that shows a failed compile or render — with `file:line:column` when the engine reports a position — on top of the last good render; a failed sync stays on the overlay until a sync succeeds, so a successful render does not hide it. Flags: `-p, --port <n>`, `-d, --data <path>` (mirrors `poli preview`), `--no-open`, and an optional positional template name.
- **`poli dev` does not require a TTY.** Unlike `poli watch`, it is a server and stays usable with its stdout piped, so it composes into a project's own dev script (`concurrently`, `npm-run-all`, a Procfile). It binds to `127.0.0.1` only, and `Ctrl-C` / `SIGTERM` closes the watcher, every SSE connection, and the port.

### Changed
- **`project.version` is optional in `poli-page.json`.** A starter carries none; `poli push` still writes it after a push.
- **The local ⇄ cloud-draft sync used by `poli watch` moved into `src/project-sync.ts`**, is now shared with `poli dev`, and now pushes only the file types the API accepts: `poli-page.json`, `tailwind.css`, any `.html` or `.json`, and image/font assets. Files outside that allowlist — including the `.gitignore` and `.prettierignore` scaffolded by `poli init` — are no longer tracked or synced, so the startup `tracking N file(s)` count is lower than before and a save touching only such files reports no changes. Previously one non-syncable file (a stray `.env`, a `README.md`) made the API reject the whole batch with a 400, failing the sync for every other file in it. `poli watch`'s output format, resilience rules, and TTY requirement are otherwise unchanged.
- **`PaymentRequiredError` (402 `PAYMENT_REQUIRED`) is replaced by `OrgPaymentGraceError` (403 `ORGANIZATION_PAYMENT_GRACE`)**, the code the API now answers for a write on an organization in payment grace (poli-page/poli-page#399). Like `OrgCancelledError`, it exits with code `5`.

### Removed
- **`poli checkout <version>` and `poli versions download <version>` are removed.** The API no longer serves a project or version bundle (`GET /api/organizations/:orgId/projects/:projectId/download` and `…/versions/:version/download` are gone, poli-page/poli-page#329): there is no pull and no checkout, and the local project is the source of truth. Restore an earlier state of a project from your own version control. For a hotfix on an older version family, pass the family to `poli push --track X.Y`. The `ApiClient.downloadVersion` method and the `ProjectBundle` type are removed with them.
- **The `getting-started` read-only guard of `poli watch` and `poli dev`.** `getting-started` is a normal project now: a `403 SYSTEM_PROJECT_LOCKED` is reported like any other API error (watch keeps watching, dev keeps rendering), without the "`getting-started` is read-only. Run `poli init`…" message.

### Fixed
- **The credentials file could be readable by other users.** `~/.polipage/credentials` was written through the umask, and an existing file or directory kept its old mode. Every write now sets the directory to `0700` and the file to `0600`; an existing file is tightened before the new secrets go in, and the write fails if it cannot be (poli-page/poli-page#151).
- **API errors never became typed errors, and printed raw JSON.** The CLI read the error code from a nested `error.code`, but the API sends it as a string in `error` (`{ "error": "<CODE>", "detail"?, "issues"?, "requestId" }`). Every API failure therefore became a generic `ApiError` with code `UNKNOWN` and the raw response body as its message, so `QuotaExceededError`, `OrgCancelledError`, `NotAMemberError`, `DocumentNotFoundError` and the rest were never built: the exit codes of cli-spec §1.2 that depend on them (`5` not authorized, `2` invalid usage) were never used, and `poli watch` / `poli dev` never retried on `503 ORGANIZATION_MIGRATING`. The CLI now reads the code from `error`, and the message from `detail`, followed by the validation `issues` when there are any. An error with no `detail` reads `<status> <CODE>` (for example `403 ORGANIZATION_CANCELLED`). Better Auth's `{ code, message }` body on `poli login` is read too. Tests now use the real envelope, including responses captured from the API (poli-page/poli-page#401).
- **On Windows, the draft sync uploaded the contents of ignored directories.** The ignore rules split paths on `/` only, but were fed the raw backslash-separated output of `relative()` — so `node_modules\pkg\thing.json` read as a single segment, matched no directory rule, passed the `.json` allowlist, and was pushed to the cloud draft (same for `.git`, `output`, and `dist` files with syncable extensions). Affected `poli watch` and `poli dev`. Paths are now POSIX-normalised inside `shouldIgnoreProjectPath` itself, so every rule holds under both separator styles for every caller.

## [0.8.2] — 2026-05-11

### Fixed
- **`poli checkout <version>` placed every file at a wrong path on disk.** The API returns "naked" paths in the bundle — symmetric with the push payload built by `collectProjectPayload`: templates as `<slug>.html` / `<slug>.json` (no `templates/<slug>/` prefix) and binary assets as `images/<rel>` or `fonts/<rel>` (no `assets/` prefix). The CLI was joining those paths to `cwd` and `cwd/assets/images/` directly, producing two pathologies: every template HTML dropped at the project root (`<projectDir>/test-welcome.html` instead of `<projectDir>/templates/test-welcome/test-welcome.html`), and every binary doubly-prefixed under `assets/images/` (so fonts ended up in `assets/images/fonts/inter-400.woff2` and images in `assets/images/images/logo.svg`, in addition to the legitimate copies a previous good checkout had written). The CLI now reconstructs the project-rooted paths on its side. Regression tests pin the placement, including a "no pathological doubles" assertion. The API contract is unchanged.

## [0.8.1] — 2026-05-11

### Fixed
- **`poli checkout <version>` no longer hangs silently.** The handler used to start the ora spinner *before* calling `executeCheckout`, which in turn fires an interactive `confirm()` prompt asking the user to acknowledge the local overwrite. The spinner covered the prompt, so the terminal showed `Checking out X.Y.Z…` spinning forever while the program was actually waiting for invisible keyboard input. The spinner is now created up-front but only `.start()`-ed after the prompt resolves with `yes` (same pattern already used by `poli init` for its template picker). The `executeCheckout` API surface is unchanged.

## [0.8.0] — 2026-05-10

Improves the VS Code / Linux developer workflow: a new `poli preview`
command for on-demand local HTML previews, harmonised output paths
across `render` and `preview`, two latent bugs in `poli watch` fixed
(binaries, Windows paths), and a scaffolded `.prettierignore` so Poli
Page's template syntax no longer triggers Prettier red-squiggles in
the editor.

### Added
- **New command `poli preview <spec>`** — renders a template to a local HTML preview file (`output/<template>/<format-orientation>/output.html` by default). Calls `POST /v1/render/preview` (no PDF, no stored document). Supports the same `<spec>` parser, `--data`, `-o`, and `--no-download` flags as `poli render`. With `--no-download`, the rendered HTML is emitted on the JSON descriptor (`html` field) instead of written to disk — useful for programmatic consumers (`poli preview invoice --no-download --json | jq '.html'`).
- **`outputPath` in `poli render --json`** — when a PDF was actually written (i.e. not `--no-download`), the JSON descriptor printed by `poli render` now carries an `outputPath` field with the absolute path to the file. Omitted when `--no-download` was passed (consumers detect "no file" by its absence).
- **`poli init` scaffolds a `.prettierignore`** — covers `templates/**/*.html`, `partials/**/*.html`, and `output/`. Poli Page's template authoring syntax (`{{ }}`, `@for`, `@if`, `@let`) is not standard HTML; Prettier's HTML parser mangles it or red-squiggles the whole file in the editor. Ignoring those paths keeps Prettier away from them while still formatting JSON mocks, `tailwind.css`, and the manifest. Existing projects: drop the same file at the project root to opt in.

### Changed (BREAKING)
- **`poli render` default output path is now `output/<template>/<format-orientation>/<template>.pdf`** (was: `output/<template>/<template>.pdf`). The new path layout lets several renders of the same template at different formats / orientations coexist on disk without overwriting each other, and aligns with the layout produced by `poli preview` and the desktop editor.

### Migration
- If your scripts or CI pipelines hard-code the old default path `output/<template>/<template>.pdf`, update them to the new layout (`output/<template>/<format-orientation>/<template>.pdf`) or pass `-o <path>` explicitly to keep the previous behaviour. The format/orientation slug is lowercased (e.g. `a4-portrait`, `letter-landscape`).

### Fixed
- **`poli watch` now correctly syncs binary assets** (images and fonts). Previously the watcher read every file as UTF-8, silently corrupting `.png`/`.jpg`/`.gif`/`.svg`/`.webp` and `.woff`/`.woff2`/`.ttf`/`.otf` content on the way to the API. These extensions are now read in buffer mode and base64-encoded — the API was already decoding base64 for assets, so existing draft assets uploaded via the editor are unaffected. The wire format `{ path, content }` is unchanged; encoding is implicit in the file extension.
- **Wire path normalisation**: `poli watch` now sends `path` entries with POSIX `/` separators on every host OS. Previously, on Windows the watcher emitted `templates\inv.html` while the API expects `templates/inv.html` — a latent issue that surfaced as templates being misclassified. Affects nobody on macOS or Linux, where the host already uses `/`.

## [0.7.1] — 2026-05-10

### Changed
- **`poli init` now scaffolds `project.version: "0.0.0"`** instead of `"1.0"` (which was a partial semver and would have been rejected by the validation introduced in 0.7.0). Combined with the API 0.7.1 change to seed bump-driven first pushes from `project.version`, this means `poli push --patch` on a fresh project produces `0.0.1` (was: forced to `1.0.0`), `--minor` → `0.1.0`, `--major` → `1.0.0`. To get a 1.0.0 first release, use `poli push --major` (or `poli push 1.0.0` explicitly).

### Migration
- Existing projects scaffolded with `"1.0"` keep their manifest as-is. The API now treats partial-semver `project.version` as a fallback to `0.0.0` (so `--patch` produces `0.0.1`). To opt into a different first version, push explicitly with `poli push X.Y.Z` or update the manifest's `project.version` first.

## [0.7.0] — 2026-05-09

Fix a subtle Commander conflict on `poli push` and `poli render`. The global
`--version` flag (registered by `program.version()` to print the CLI version)
was shadowing the per-subcommand `--version` flag, so `poli push --version
1.2.3` and `poli render invoice --version 1.0.0` printed the CLI version
instead of executing the command. Rather than bend Commander out of shape
to coexist with `--version`, we drop the flag entirely from both
subcommands and adopt cleaner surfaces.

### Changed (BREAKING)
- **`poli push --version <X.Y.Z>` is replaced by a positional argument:
  `poli push <X.Y.Z>`.** Aligns with `poli checkout <version>`. All other
  flags (`--patch`, `--minor`, `--major`, `--track`, `-m`, `--json`) are
  unchanged. Mutual-exclusion rules preserved: an explicit version cannot
  be combined with `--bump` variants or `--track`.
- **`poli render <name> --version <X.Y.Z>` is replaced by an npm-style
  spec: `poli render <name>@<X.Y.Z>`.** `poli render invoice` keeps its
  current behaviour (renders the draft); `poli render invoice@draft`
  is the explicit equivalent. Convention shared with `npm install
  pkg@version`, `docker pull image:tag`, `pip install pkg==version`.
- **Friendly error messages for `latest` retired / partial semver no
  longer mention `--version`.** They now point at the new surface
  (`poli push 1.2.3` and `name@1.2.3`).

### Migration
- `poli push --version 1.2.3` → `poli push 1.2.3`
- `poli render invoice --version 1.0.0` → `poli render invoice@1.0.0`
- `poli render invoice` (draft) is unchanged.

## [0.6.1] — 2026-05-07

UX cleanup pass after the 0.6.0 stabilisation. Drops the redundant
`poli thumbnail` alias, unifies the `--json` flag semantics across
all data-producing commands, and adds smarter defaults to `poli new`.

### Removed (BREAKING)
- **`poli thumbnail <documentId>` alias** is gone. Use the canonical
  `poli documents thumbnails <documentId>` instead. The alias added
  surface area without earning its keep — one way to do it is clearer
  than two.

### Added
- **Unified `--json` + auto-detect TTY across data commands.** New
  shared helper `src/output.ts:shouldEmitJson(opts)` decides whether
  to emit JSON or the human-friendly summary. Rule:
  1. `--json` flag → always JSON
  2. stdout not a TTY (pipe, redirect, CI) → JSON
  3. stdout is a TTY → human summary
  Never both — one or the other on stdout. Applied to:
  `render`, `documents get`, `documents preview`, `documents thumbnails`,
  `whoami`, `versions list`, `push`, `promote`, `unpromote`,
  `versions deprecate`, `versions un-deprecate`. The previous behaviour
  on `documents get` and `render` (printing the JSON to stdout AND a
  summary on stderr in the same invocation) is fixed — pipelines now
  see clean JSON and TTY users see clean summaries.

### Changed
- **`poli documents get` now matches `poli render` output contract.**
  The JSON descriptor is always printed to stdout (16 fields, same
  shape as `poli render`), the human-friendly summary goes to stderr
  (and only when stderr is a TTY). The `--json` flag is removed — it
  was redundant since JSON is now the default. Pipelines can chain
  the two commands without filtering:
  ```bash
  $ poli documents get $DOC_ID | jq '.presignedPdfUrl'
  ```
  Also fixes the cosmetic `(vnull)` display when `version` is `null`
  (draft document) — now shown as `draft`.
- **`poli new` now defaults to `structures/blank` when no template is
  provided.** Previously it threw `"Missing --from-template"` either when
  the interactive prompt returned `null` (user said No) or in non-TTY
  contexts without the flag. Since `poli new` always produces a template
  by definition, falling back to the minimal blank template is a more
  helpful default. Pass `--from-template <coll>/<tpl>` to pick anything
  else explicitly.

## [0.6.0] — 2026-05-07

API surface stabilisation. The server now uniformly returns a JSON
descriptor for every render (no more PDF binary), and the CLI follows.
Plus version `track` support for the hotfix workflow.

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
- **Version `track` support** in `poli push` (api-spec §9.1) — enables the
  hotfix flow when a SANDBOX is more recent than the LIVE you need to patch.
  - `poli checkout X.Y.Z` now writes `cloud.track = "X.Y"` to the manifest.
  - `poli push` reads `cloud.track` and forwards it in the body, so
    `--patch` and `--minor` are anchored on that family. `--major` ignores
    the track and always picks `max(major)+1`.
  - Post-push, `cloud.track` is updated to the major.minor of the version
    the server returned (no-op for patches on the same family).
  - Two new flags on `poli push`:
    - `--version <X.Y.Z>` — explicit version mode (mutually exclusive with
      `--patch`/`--minor`/`--major`/`--track`). 409 `VERSION_CONFLICT` if
      the version already exists in any state.
    - `--track <X.Y>` — override the manifest track (CI use, no manifest).
  - **Hotfix scenario**: 1.0.1 LIVE in prod, 2.0.0 SANDBOX in dev.
    Before: `poli push --patch` after `checkout 1.0.1` produced 2.0.1.
    After: 1.0.2.
- New typed errors: `InvalidTrackFormatError` (400), `VersionConflictError`
  (409). Both mapped in the error registry.
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

[0.6.1]: https://github.com/poli-page/cli/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/poli-page/cli/compare/v0.5.0...v0.6.0

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
