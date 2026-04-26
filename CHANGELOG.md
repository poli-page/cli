# Changelog

All notable changes to `@poli-page/cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/poli-page/cli/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/poli-page/cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/poli-page/cli/releases/tag/v0.1.0
