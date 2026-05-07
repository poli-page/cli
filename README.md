# Poli Page CLI

[![npm version](https://img.shields.io/npm/v/@poli-page/cli.svg)](https://www.npmjs.com/package/@poli-page/cli)
[![CI](https://github.com/poli-page/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/poli-page/cli/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@poli-page/cli.svg)](LICENSE)

Command-line tool for [Poli Page](https://poli.page) — scaffold projects, manage cloud-hosted templates, render PDFs, and operate document storage from your terminal or your CI pipeline.

---

## Table of contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Authentication](#authentication)
- [Commands](#commands)
  - [Project lifecycle](#project-lifecycle)
  - [Authentication commands](#authentication-commands)
  - [Cloud sync](#cloud-sync)
  - [Versioning](#versioning)
  - [Render](#render)
  - [Documents](#documents)
- [Manifest format](#manifest-format)
- [Configuration](#configuration)
- [Exit codes](#exit-codes)
- [CI / CD](#ci--cd)
- [Troubleshooting](#troubleshooting)

---

## Install

```bash
npm install -g @poli-page/cli
# or
pnpm add -g @poli-page/cli
# or
bun add -g @poli-page/cli
```

**Requirements**: Node.js 22.13 or later.

Verify the install:

```bash
poli --version
poli --help
```

---

## Quickstart

```bash
# 1. Authenticate (opens your browser for the device flow)
poli login

# 2. Scaffold a new project
poli init my-invoices
cd my-invoices

# 3. Add a template from the Poli Page starter collection
poli new invoice --from-template showcase/invoice

# 4. Link the project to your organization (writes the cloud manifest)
poli link

# 5. Render a PDF using the local template against the cloud engine
poli render invoice -o invoice.pdf

# 6. Push your work as a SANDBOX version
poli push --message "Initial draft"

# 7. Promote to LIVE when ready
poli versions list
poli promote 1.0.0
```

To iterate on a template with live feedback against the cloud:

```bash
poli watch
# edit your template files; each save syncs to the cloud draft within 2 seconds
```

---

## Authentication

The CLI supports two authentication modes. Both flow through the same internal resolver.

### Interactive (developers)

```bash
poli login    # device authorization flow — opens your browser
poli whoami   # show the current session and active org
poli logout   # clear ~/.polipage/credentials.json
```

After `poli login`, the session token is stored at `~/.polipage/credentials.json` and used automatically by every subsequent command.

### Programmatic (CI / CD / scripts)

Set the `POLI_PAGE_API_KEY` environment variable. The value must start with `pp_`:

| Prefix      | Use case                                                          |
| ----------- | ----------------------------------------------------------------- |
| `pp_test_*` | Sandbox renders (unmetered, no quota)                             |
| `pp_live_*` | Live renders (counts in the monthly quota, billable)              |
| `pp_sa_*`   | Service account — recommended for CI; rotates without breaking dev|

```bash
export POLI_PAGE_API_KEY=pp_sa_live_xxx
poli render invoice -o invoice.pdf
poli push --message "Release v1.0.5"
```

### Precedence

When **both** `~/.polipage/credentials.json` (a session) and `POLI_PAGE_API_KEY` are set, **the session wins**. `poli login` does not refuse if the env var is set — it shows an info-message and proceeds, after which the new session takes precedence.

This means a developer can keep `POLI_PAGE_API_KEY` set in `.zshrc` for occasional CI-style commands without it interfering with their interactive workflow.

---

## Commands

24 commands grouped by category.

### Project lifecycle

#### `poli init <name>`

Scaffold a new Poli Page project. Creates the directory, the `poli-page.json` manifest, `templates/`, `partials/`, `assets/{fonts,images}/`, `tailwind.css`, and `.gitignore`.

```bash
poli init my-invoices                                   # interactive: prompts to add a starter
poli init . --with-template showcase/invoice            # init in cwd + import an explicit starter
poli init my-app --with-template showcase/quote --template-name custom-quote
poli init my-app --source github:my-org/my-templates --with-template internal/cover
```

Run without `--with-template` in an interactive shell to be prompted for a collection, a template (with descriptions), and the destination template name in your project (default = source template name; press Enter to keep, or type a new name). In non-interactive shells (CI), the prompt is skipped and the project is created without a starter — pass `--with-template` explicitly when needed.

Flags:

- `--with-template <ref>` — pre-install a starter template, format `<collection>/<template>`. Skips the interactive prompt.
- `--template-name <name>` — override the imported template's destination name
- `--source <repo>` — source repo, format `github:<owner>/<repo>` (default: `github:poli-page/templates`)
- `--no-cache` — bypass the 24-hour template cache

#### `poli new <name>`

Create a new template inside an existing project from a remote starter.

```bash
poli new invoice                                # interactive: prompts for collection/template
poli new invoice --from-template showcase/invoice
poli new quote --from-template structures/blank
```

Run without `--from-template` in an interactive shell to be prompted for a collection/template. If you decline the prompt (or run in CI without the flag), the command falls back to **`structures/blank`** — the minimal blank template — rather than erroring out. Pass `--from-template <coll>/<tpl>` to pick anything else explicitly.

Flags:

- `--from-template <ref>` — collection/template. Skips the interactive prompt.
- `--source <repo>` — override the source
- `--no-cache` — bypass cache

### Authentication commands

#### `poli login`

Opens your browser for the device authorization flow and stores the session token at `~/.polipage/credentials.json`.

#### `poli logout`

Clears the local credentials file.

#### `poli whoami`

Displays the active identity and organization. Calls `GET /v1/me` over hybrid auth (session or API key).

```bash
# Inside a linked project (session)
$ poli whoami
xavier@example.com @ acme (session)

# Anywhere — fallback when no project is linked, lists the orgs the session can see
$ poli whoami
xavier@example.com (session, 2 organizations: acme, demo-corp)
  Run `poli link` inside a project to bind it to an organization.

# Programmatic (API key)
$ POLI_PAGE_API_KEY=pp_live_xxx poli whoami
pp_live_xxx…abcd @ acme (api-key, environment=live)
```

Flag: `--json` to dump the raw `/v1/me` payload (or, in `session-no-org` mode, `{ mode, user, orgs }`).

### Cloud sync

#### `poli link`

Interactively select an organization, create the cloud project, and write the `cloud:` section into `poli-page.json` with the four fields the API needs (`orgSlug`, `orgId`, `projectSlug`, `projectId`). No API key is stored in the manifest — the file is safe to commit.

#### `poli unlink`

Removes the `cloud:` section from `poli-page.json`. Local files are preserved.

#### `poli watch`

Auto-syncs the local project to the cloud draft on every save. Debounce 2s. Each batch sends only the SHA-256 delta via `PATCH /api/organizations/:orgId/projects/:projectId/files`.

```bash
poli watch
```

Resilience built in:

- Network errors → exponential backoff (1s, 2s, 4s, 8s, 16s, 30s capped, reset on success)
- `503 ORGANIZATION_MIGRATING` → 5-second retry
- `403 SYSTEM_PROJECT_LOCKED` (the `getting-started` system project) → friendly error + exit
- Other API errors → logged, watch continues, next save retries

Requires a TTY. Refused with exit `2` when run in a non-interactive context.

#### `poli checkout <version>`

Restore a specific published version locally. **Destructive** — overwrites any local file with the same path. Always commit your work before running.

```bash
poli checkout 1.0.5    # exact semver only
```

`latest` and partial semver (`1.0`, `1`) are rejected with a friendly hint.

Side effect: writes `cloud.track = "X.Y"` to the manifest (derived from the checked-out version). `poli push --patch` / `--minor` will then be anchored on that track — see the hotfix flow above.

### Versioning

#### `poli push`

Sync the current local draft and create a new SANDBOX version. The body shape is one of two mutually exclusive forms (api-spec §9.1):

- Bump-driven: `--patch` (default), `--minor`, or `--major`. Anchored on the manifest's `cloud.track` (set by `poli checkout`).
- Explicit: `--version <X.Y.Z>`. The server returns 409 `VERSION_CONFLICT` if the version already exists in any state.

```bash
poli push --message "Tweaked invoice header"        # patch (default), anchored on cloud.track
poli push --major --message "BREAKING: new schema"  # ignores track, picks max(major)+1
poli push --minor
poli push --version 1.0.2                           # explicit version (no track logic)
poli push --track 1.0 --patch                       # override the manifest track (CI)
```

**Hotfix flow** — 1.0.1 LIVE in prod, 2.0.0 SANDBOX in dev:

```bash
poli checkout 1.0.1     # writes cloud.track = "1.0"
# fix the bug…
poli push --patch       # produces 1.0.2 (anchored on track 1.0), not 2.0.1
poli promote 1.0.2
```

After the push, `cloud.track` is updated to the major.minor of the version the server returned (no-op for patches on the same family).

#### `poli versions list` (alias `ls`)

Display all versions of the linked project with their state badges.

```
STATE       VERSION    PUSHED        MESSAGE
LIVE        2.0.0      3 days ago    Major redesign
LIVE        1.0.5      1 week ago    Hotfix URSSAF
SANDBOX     1.1.0      2 hours ago
DEPRECATED  1.0.2      3 weeks ago
```

#### `poli promote <version>`

Move a SANDBOX version to LIVE. Confirmation prompt unless `--yes`.

#### `poli unpromote <version>`

Move a LIVE version back to SANDBOX. Shows a usage preview (calls in the last 24h, the next-latest LIVE) before confirming.

```bash
poli unpromote 1.0.5
poli unpromote 1.0.5 --force    # allow unpromoting the last LIVE version
```

#### `poli versions deprecate <version>`

Mark a SANDBOX version as DEPRECATED.

#### `poli versions un-deprecate <version>`

Move a DEPRECATED version back to SANDBOX.

#### `poli versions download <version> [-o <dir>]`

Download a published version's content to a local directory (read-only inspection or hotfix base).

### Render

#### `poli render <name>`

Render a template against the cloud engine. Every render produces a stored document (api-spec §11.3) — the CLI receives a JSON descriptor with `documentId`, `presignedPdfUrl`, `expiresAt`, and 13 other fields. By default it then fetches the URL and writes the PDF locally; pass `--no-download` to skip that step.

```bash
poli render invoice                                          # default: draft, downloads PDF
poli render invoice --version 1.0.5                          # exact semver pin
poli render invoice --version draft --data ./mock.json       # custom data
poli render invoice -o ./out/invoice.pdf                     # custom path
poli render invoice --no-download                            # JSON descriptor only
```

Flags:

- `--version <draft|X.Y.Z>` — exact semver only (`latest` is rejected)
- `--data <file>` — JSON data overrides the mock
- `-o <file>` — output PDF path. Incompatible with `--no-download`
- `--no-download` — skip the presigned URL fetch (CI/CD pipelines)

The JSON descriptor is **always** printed to stdout, the success line (`✓`) to stderr — so you can pipe to `jq`:

```bash
$ DOC_ID=$(poli render invoice | jq -r '.documentId')
$ poli documents thumbnails "$DOC_ID" --width 400
```

Resolved environment is exposed in the success line:

```
✓ Rendered invoice v1.0.5 (live, billed) → ./output/invoice/invoice.pdf
✓ Rendered invoice vdraft (sandbox) → ./output/invoice/invoice.pdf
```

Counter:
- `version: draft` or `X.Y.Z` SANDBOX/DEPRECATED → unmetered
- `version: X.Y.Z` LIVE → counts in monthly quota

### Documents

Documents are the cloud-stored output of `render document` calls (made via the SDK or directly via the API). The CLI lets you inspect, delete, and re-derive thumbnails or preview HTML from them.

There is intentionally **no `poli documents list`** — your application is responsible for tracking the `documentId` values it cares about.

#### `poli documents get <id>`

Returns the document JSON descriptor (same 16-field shape as `poli render`) on stdout, plus a human-friendly summary on stderr when run from a terminal. The CLI does not download the PDF — `curl` the `presignedPdfUrl` or hand it to the browser yourself.

```bash
poli documents get doc_abc123
poli documents get doc_abc123 | jq '.presignedPdfUrl'   # pipe-friendly
```

#### `poli documents delete <id>`

Soft-deletes a document. Idempotent: returns success if already deleted. Confirmation unless `--yes`.

#### `poli documents thumbnails <id>`

Regenerate page thumbnails from the document's stored canonical HTML. Counts as one billable render in the monthly quota when the auth env is `live`. Free tier returns `403 THUMBNAILS_NOT_AVAILABLE`.

```bash
poli documents thumbnails doc_abc123 --width 400
poli documents thumbnails doc_abc123 --pages 1,3 --format jpeg --quality 85
poli documents thumbnails doc_abc123 -o ./out
```

Flags: `-w/--width`, `-f/--format png|jpeg`, `-q/--quality`, `--pages 1,3`, `-o/--output`, `--json`.

#### `poli documents preview <id>`

Fetch the stored canonical HTML re-wrapped as preview-mode (free, no quota cost). Default writes the file at `./output/documents/<id>.preview.html` and opens the browser.

```bash
poli documents preview doc_abc123
poli documents preview doc_abc123 --no-open
poli documents preview doc_abc123 -o ./preview.html
```

---

## Manifest format

`poli-page.json` is the per-project manifest. Committed to git (no secrets).

```jsonc
{
  "project": {
    "name": "my-invoices",
    "version": "1.0.0"
  },
  "fonts": [
    {
      "family": "Inter",
      "src": "assets/fonts/Inter.woff2",
      "weight": 400
    }
  ],
  "templates": [
    {
      "name": "invoice",
      "template": "templates/invoice/invoice.html",
      "mock": "templates/invoice/invoice.json",
      "format": "A4",
      "orientation": "portrait"
    }
  ],
  "cloud": {
    "orgSlug": "acme",
    "orgId": "0e89d99e-1516-4b48-baa1-f49e660ad1c1",
    "projectSlug": "invoices",
    "projectId": "8274f64d-4ea2-4f96-b596-5727a7b17268"
  }
}
```

The `cloud:` block is written by `poli link`, removed by `poli unlink`. **No API keys here** — the credentials file (or `POLI_PAGE_API_KEY`) carries the secret.

---

## Configuration

### Environment variables

| Variable             | Effect                                                                                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POLI_PAGE_API_KEY`  | Single env var for any API key in CI/CD. Accepts `pp_test_*`, `pp_live_*`, or `pp_sa_*`. Must start with `pp_`. **Precedence**: when a credentials file is also present, the session wins.                                                       |
| `POLI_API_URL`       | Override the API base URL (precedence: `--api-url` flag → `POLI_API_URL` → `poli-page.json` `cloud.apiUrl` → `~/.polipage/credentials.json` `apiUrl` → default `https://api.poli.page`).                                                          |
| `POLI_PAGE_ENV`      | Default render env (`sandbox` or `live`) when commands accept an env hint.                                                                                                                                                                       |
| `NO_COLOR`           | Disable ANSI colors (Unix standard).                                                                                                                                                                                                            |
| `CI`                 | Auto-detected; equivalent to a global `--yes`.                                                                                                                                                                                                  |

### Common flags

- `--api-url <url>` — override the API base URL for one invocation
- `--json` — structured JSON output (where supported)
- `-y` / `--yes` — skip confirmation prompts
- `-h` / `--help` — show help for any command or sub-command
- `-v` / `--version` — print the CLI version and exit

---

## Exit codes

| Code | Meaning                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------ |
| `0`  | Success (or no-op, e.g. `promote` when nothing changes)                                                |
| `1`  | Recoverable inconsistency (already logged in, already linked, version already live)                    |
| `2`  | Invalid usage (bad args, template not found, version not found, non-TTY context where TTY is required) |
| `3`  | Network / API error (timeout, 5xx, unspecified 4xx)                                                    |
| `4`  | Not authenticated — run `poli login` or set `POLI_PAGE_API_KEY`                                        |
| `5`  | Not authorized (insufficient role, `THUMBNAILS_NOT_AVAILABLE`, system project locked)                  |
| `6`  | Invalid local state (no project, project not linked, empty folder where required)                      |

These map to the centralised `ExitCode` constants in `src/exit-codes.ts`. Every handler routes errors through `errorToExitCode(err)`.

---

## CI / CD

### GitHub Actions

```yaml
# .github/workflows/render.yml
name: Render PDFs

on: workflow_dispatch

jobs:
  render:
    runs-on: ubuntu-latest
    env:
      POLI_PAGE_API_KEY: ${{ secrets.POLI_PAGE_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm install -g @poli-page/cli
      - run: poli render invoice -o ./artifacts/invoice.pdf --version 1.0.5
      - uses: actions/upload-artifact@v4
        with:
          name: invoice-pdf
          path: ./artifacts/invoice.pdf
```

Recommended: use a **service account key** (`pp_sa_live_*`) so rotating it does not log out any developer.

### GitLab CI

```yaml
render:
  image: node:22-alpine
  variables:
    POLI_PAGE_API_KEY: $POLI_PAGE_API_KEY
  script:
    - npm install -g @poli-page/cli
    - poli render invoice -o invoice.pdf --version 1.0.5
  artifacts:
    paths:
      - invoice.pdf
```

### Vercel / Netlify build hook

```bash
# In a build script
npm install -g @poli-page/cli
POLI_PAGE_API_KEY=pp_sa_live_xxx poli render homepage-pdf -o ./public/welcome.pdf
```

Service accounts have a **fixed role and environment** at creation. The CLI does not try to switch them — the API enforces the permissions.

---

## Troubleshooting

### `Not logged in. Run \`poli login\` or set POLI_PAGE_API_KEY.`

Either run `poli login` interactively, or export `POLI_PAGE_API_KEY` for CI use. Exit code `4`.

### `POLI_PAGE_API_KEY must start with \`pp_\`...`

You set the variable but its value does not match the `pp_*` prefix. Rotate the key from the dashboard's API keys page. Exit code `4`.

### `This folder isn't linked to a cloud project. Run \`poli link\` first.`

You're in session mode and the local manifest has no `cloud:` block. Either run `poli link`, or switch to api-key mode with `POLI_PAGE_API_KEY=pp_*` (which carries the org context implicitly). Exit code `6`.

### `\`latest\` was retired. Run \`poli versions list\` and pin an exact semver...`

The CLI now requires an exact `X.Y.Z` semver when pinning a version. List the published versions with `poli versions list` and pick one. Exit code `2`.

### `403 THUMBNAILS_NOT_AVAILABLE`

Thumbnails via `poli documents thumbnails` are a paid-tier feature. Upgrade to Starter from the dashboard. Exit code `5`.

### `429 OVERAGE_CAP_EXCEEDED`

Your org has crossed the monthly cap on `live` PDF renders (counted across `render`, `render document`, and `documents thumbnails` calls). Wait until the next billing period or raise the cap from your dashboard. Exit code `3`.

### `503 ORGANIZATION_MIGRATING`

Your org is being migrated to a new tier. `poli watch` retries automatically after 5s. Other commands surface the error — retry by hand once the migration completes (typically under a minute).

### `poli watch` doesn't fire on save

Make sure you're not editing inside an ignored directory. Default ignores: `node_modules/`, `.git/`, `output/`, `dist/`, `*.log`, `.DS_Store`. The watcher uses `chokidar` v5; if your editor saves via "atomic write + rename" (some Vim setups), the rename event fires within the debounce window and triggers a sync.

### CI pipeline rejected with exit `5` on `poli promote`

Service-account `developer` keys cannot promote. Either use an `admin` SA, or run `poli promote` from a developer's interactive session. Service-account roles are fixed at creation.

---

## License

MIT — see [LICENSE](LICENSE).

## Links

- [Documentation](https://docs.poli.page)
- [Dashboard](https://app.poli.page)
- [Issue tracker](https://github.com/poli-page/cli/issues)
- [Changelog](CHANGELOG.md)
