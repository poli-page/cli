# Changelog

All notable changes to `@poli-page/cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
