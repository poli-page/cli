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
    - [Live development](#live-development)
    - [Environments](#environments)
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

# 5. Render the draft (the files `poli link` uploaded) to a PDF
poli render invoice -o invoice.pdf

# 6. Publish the project to the sandbox environment
poli publish --env sandbox

# 7. Publish it to live when ready
poli publish --env live -m "First release"
```

To iterate on a template with live feedback against the cloud:

```bash
poli dev
# opens http://127.0.0.1:7654 — edit a template, save, and the browser
# reloads the freshly rendered PDF of your draft
```

`poli dev` is the code-first alternative to the desktop editor. If you only want
the sync half, without a browser, use `poli watch`.

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

Set the `POLI_PAGE_API_KEY` environment variable. Every key is bound to one environment and carries its name: `pp_<environment>_` followed by 32 lowercase hex characters. The CLI checks the whole key before any call.

| Key                  | Renders                                             |
| -------------------- | --------------------------------------------------- |
| `pp_sandbox_…`       | `name@sandbox` — free, watermarked, not counted     |
| `pp_live_…`          | `name@live` — counted in the monthly quota          |
| `pp_<environment>_…` | `name@<environment>` — counted in the monthly quota |

A key renders only its own environment, and never the draft: the draft (`poli render name`) needs `poli login`.

```bash
export POLI_PAGE_API_KEY=pp_live_xxx
poli render invoice@live -o invoice.pdf
poli publish --env live -m "Release from CI"   # service key only
```

Standard keys and service keys share the `pp_<environment>_…` format; the CLI asks `GET /v1/me` which one it holds:

- a **standard key** renders only. `poli publish` refuses it before any upload (exit `5`).
- a **service key** (recommended for CI) also publishes, into its own environment only: `--env` is still required and must name the environment in the key (exit `2` otherwise). Its role decides on a protected environment: an `admin` service key can publish to one, a `developer` one gets `ENVIRONMENT_PROTECTED` (exit `5`). Nothing prompts.

The other workspace commands (`link`, `watch`, `dev`) need `poli login`.

### Precedence

When **both** `~/.polipage/credentials.json` (a session) and `POLI_PAGE_API_KEY` are set, **the session wins**. `poli login` does not refuse if the env var is set — it shows an info-message and proceeds, after which the new session takes precedence.

This means a developer can keep `POLI_PAGE_API_KEY` set in `.zshrc` for occasional CI-style commands without it interfering with their interactive workflow.

---

## Commands

17 commands grouped by category.

### Project lifecycle

#### `poli init <name>` / `poli init --starter <name> [dir]`

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

##### `--starter getting-started` — start from your org's getting-started project

```bash
poli init --starter getting-started            # writes ./getting-started
poli init --starter getting-started my-start   # writes ./my-start
```

Writes the whole `getting-started/` project of [`poli-page/templates`](https://github.com/poli-page/templates) (templates, mocks, `poli-page.json`, `tailwind.css`, fonts and images) into `dir` (default: `./getting-started`). The files come from the public templates repo — the same source your org's `getting-started` project was created from — nothing is downloaded from the cloud.

When you are logged in, the folder is linked to the **existing** `getting-started` project of your organization (it never creates a cloud project). If you belong to several organizations, pass `--org <slug>` (or pick one at the prompt). Logged out, or when the organization has no `getting-started` project, the starter is written unlinked and the command tells you how to link it (`poli login`, then `poli link`).

A non-empty target directory is refused unless you pass `--force`. Then:

```bash
cd getting-started
poli watch                   # live sync of your edits to the cloud draft
poli publish --env sandbox   # publish the project to the sandbox environment
```

and re-run the dashboard snippet to see your change.

Piped, or with `--json`, it prints `{ starter, projectDir, link }` as JSON instead (`link` is `{ status: "linked", orgSlug }` or `{ status: "unlinked", reason }`) and never prompts. `<name>` is one top-level folder of the source (no `/`).

Flags: `--starter <name>`, `--org <slug>`, `--force`, `--json`, plus `--source` and `--no-cache` as above.

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
xavier@example.com @ acme (session, role=owner)

# Anywhere — fallback when no project is linked, lists the orgs the session can see
$ poli whoami
xavier@example.com (session, 2 organizations: acme, demo-corp)
  Run `poli link` inside a project to bind it to an organization.

# Programmatic (API key)
$ POLI_PAGE_API_KEY=pp_live_xxx poli whoami
pp_live_xxx…abcd @ acme (api-key, environment=live)

# A service key also shows its role (a session shows the member's role)
$ POLI_PAGE_API_KEY=pp_staging_xxx poli whoami
pp_staging_xxx…abcd @ acme (api-key, environment=staging, role=admin)
```

Flag: `--json` to dump the raw `/v1/me` payload (or, in `session-no-org` mode, `{ mode, user, orgs }`).

### Cloud sync

#### `poli link`

Interactively select an organization, create the cloud project, and write the `cloud:` section into `poli-page.json` with the four fields the API needs (`orgSlug`, `orgId`, `projectSlug`, `projectId`). No API key is stored in the manifest — the file is safe to commit.

#### `poli unlink`

Removes the `cloud:` section from `poli-page.json`. Local files are preserved.

#### `poli watch`

Auto-syncs the local project to the cloud draft on every save. Debounce 2s. Each batch sends only the SHA-256 delta via `PATCH /api/organizations/:orgId/projects/:projectId/files`. It syncs the same file set as [`poli publish`](#poli-publish), each file with its encoding (`base64` for assets, `utf8` otherwise); other files are not tracked.

```bash
poli watch
```

Resilience built in:

- Network errors → exponential backoff (1s, 2s, 4s, 8s, 16s, 30s capped, reset on success)
- `503 ORGANIZATION_MIGRATING` → 5-second retry
- Other API errors → logged, watch continues, next save retries

Requires a TTY. Refused with exit `2` when run in a non-interactive context. If
you need the same sync inside a script or alongside a browser preview, use
[`poli dev`](#poli-dev-template), which has no TTY requirement.

### Live development

#### `poli dev [template]`

Live PDF preview server for template authors. On every save it syncs the
project to the cloud draft, renders the active template's draft to PDF through
`POST /v1/render/draft` with your signed-in session, and pushes a reload to every
connected browser over Server-Sent Events — no polling, no fixed delay. Draft
renders are session-only: they carry no watermark, are never stored as a
document, and are not counted. `POLI_PAGE_API_KEY` plays no part: an API key
cannot render the draft.

```bash
poli dev                 # first template in the manifest
poli dev invoice         # start on a specific template
poli dev --port 8123     # pick the port
poli dev --no-open       # don't launch a browser
poli dev -d ./big.json   # render every template against your own data
```

| Flag                | Default           | Meaning                                                     |
| ------------------- | ----------------- | ----------------------------------------------------------- |
| `-p, --port <n>`    | `7654`            | Port to bind on `127.0.0.1`. Walks upwards when it is busy. |
| `-d, --data <path>` | the template mock | JSON data file, same shape as `poli render -d`.             |
| `--no-open`         | opens the browser | Skip launching a browser on start.                          |
| `[template]`        | first in manifest | Which template to show first.                               |

The served page gives you:

- **A template switcher.** By default the view _follows the most recently
  changed template_: a save under `templates/<name>/` makes `<name>` the active
  one. When a batch touches several templates, the one with the newest mtime
  wins. A change to a file that no single template owns — a shared partial,
  `tailwind.css`, an asset, or `poli-page.json` — belongs to all of them and so
  moves nothing: the current template stays on screen and is re-rendered.
- **A pin.** Click _Pin_ to freeze the view on the current template so an
  unrelated save cannot yank you away. Unpin to follow again.
- **The real PDF.** Every render is the actual PDF of the draft — pagination,
  page breaks, fonts — shown in the browser's PDF viewer and reloaded after each
  successful sync. There is no separate HTML preview mode.
- **An error overlay.** A failed compile or render is shown with its message
  (and `file:line:column` when the engine reports a position) on top of the last
  good PDF, which stays visible behind it. A render error clears on the next
  successful render; a failed sync stays shown until a sync succeeds, even when
  a render succeeds in between (the cloud draft is still out of date).

Notes:

- **No TTY required.** Unlike `poli watch`, `poli dev` is a server and runs
  happily with its stdout piped, so you can compose it into your own dev script:

    ```json
    { "scripts": { "dev": "concurrently \"poli dev --no-open\" \"vite\"" } }
    ```

- It binds to `127.0.0.1` only — the rendered draft is never exposed to the
  local network.
- On start it pushes the whole working tree to the draft, so the first render
  reflects your local files rather than whatever the draft last contained.
- Failures are surfaced, not fatal: a render that errors, a rejected sync, a
  broken `poli-page.json`, or a dropped connection leave the server up and the
  page serving.
- `Ctrl-C` (or `SIGTERM`) closes the watcher, every SSE connection, and the
  port.

### Environments

#### `poli publish`

Publishes the local project, the files on disk, to an environment of your organization: `POST /v1/projects/<projectSlug>/publish`, with your `poli login` session and the manifest's `cloud.orgId`, or, without a session, with a service key in `POLI_PAGE_API_KEY` (see below). The environment's copy of the project is replaced in place. There is no rollback: to go back, check out the earlier state from your own version control and publish again.

```bash
poli publish --env sandbox
poli publish --env live -m "Invoice footer fix"
poli publish --env live --yes      # protected environment, no prompt (scripts)
```

| Flag                   | Meaning                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `--env <name>`         | Required. The target environment; there is no default, and `draft` is not an environment. |
| `-m, --message <text>` | Kept in the publish log with the date, author and bundle hash. 500 characters at most.    |
| `-y, --yes`            | Publish to a protected environment without the confirmation prompt.                       |
| `--json`               | Print the API response as JSON (also the default when stdout is not a TTY).               |

- **Environment names** are 1-20 characters: lowercase letters, digits and single inner hyphens, starting with a letter. A name that breaks this rule is refused before any call (exit `2`). An environment that does not exist in the organization is refused with the list of the ones that do (exit `2`).
- **The bundle** is the project file set: `poli-page.json`, `tailwind.css`, the `.html`, `.json` and `.css` files under `templates/<slug>/`, the `.html` files under `partials/`, everything under `assets/images/` and `assets/icons/`, and the `.woff2`, `.woff`, `.ttf` and `.otf` files under `assets/fonts/`. Anything else (`.gitignore`, `README.md`, `output/`, `node_modules/`) is left out. Assets are sent base64-encoded, every other file as UTF-8. A bundle over 5 MiB, or a message over 500 characters, is refused before any call (exit `2`).
- **Protected environments** (`live` by default) accept a publish from an owner or an admin only. In a terminal, `poli publish` asks for confirmation first; without a TTY it needs `--yes`, and `CI=true` counts as `--yes`. Without the role, the API refuses with `ENVIRONMENT_PROTECTED` (exit `5`).
- **With a service key** (`POLI_PAGE_API_KEY` and no `poli login` session; a session wins when both are there): the CLI calls `GET /v1/me`, then publishes to the manifest's `cloud.projectSlug` with no organization header, since the key carries its organization. `--env` must name the key's own environment, or the publish is refused before any upload, naming it (exit `2`). A standard key is refused with "Standard API keys can only render. Use a service key or `poli login`." (exit `5`). There is no prompt and no environment check on the CLI side: the API applies the protected-environment rule, and a service key without the `admin` role gets `ENVIRONMENT_PROTECTED` (exit `5`).
- **One publish at a time** per project and environment: while one runs, a second gets `PUBLISH_IN_PROGRESS` (exit `3`). It is not retried; run it again once the first one is done.

On success it prints the environment, the project, the short bundle hash, the file count and the publish log id.

#### `poli env list`

Lists your organization's environments, with your `poli login` session (any member of the organization can run it).

```bash
poli env list                # in a linked folder: the project's state in each environment
poli env list --org acme     # elsewhere, or for another organization
poli env list --json
```

| Flag           | Meaning                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| `--org <slug>` | The organization to list. Default: the linked project's organization, else your only one. |
| `--json`       | Print the API response as JSON (also the default when stdout is not a TTY).               |

In a linked folder, each environment shows whether it is protected and read-only, whether the project is published there, and the project's last publish in it: its status (`succeeded`, `in-progress`, or `failed` with the API's error code), its date (UTC), its author, its short bundle hash and its message, or `not published`. The last publish is the latest attempt, so a failed one shows even when an earlier publish is still the one served.

```
Environments of acme, project invoices:

  ENVIRONMENT  PROTECTED  READ-ONLY  PUBLISHED  LAST PUBLISH
  sandbox      no         no         yes        succeeded  2026-10-26 10:00 UTC  Ada Lovelace  0123456789ab  Invoice footer fix
  live         yes        no         no         not published
```

Outside a linked folder, or with `--org` naming another organization, it lists the organization's environments with their protected and read-only flags and how many projects are published in each (`PROJECTS`). When you belong to several organizations and no project is linked, `--org` is required: without it the command exits `2` and lists your organizations' slugs. An environment is read-only when the organization's plan no longer covers it.

#### `poli env remove-project <environment>`

Removes the linked project from an environment: the environment's copy of the project is deleted, and the documents rendered from it are kept. The draft and the other environments are untouched, nothing is written to the publish log, and renders of the project in that environment then get `PROJECT_NOT_IN_ENVIRONMENT` until a later `poli publish --env <environment>` adds it back. Only an owner or an admin of the organization can do it, in every environment.

```bash
poli env remove-project staging          # asks you to type the project slug
poli env remove-project staging --yes    # scripts: no prompt
```

| Flag        | Meaning                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| `-y, --yes` | Remove without typing the project slug to confirm.                                 |
| `--json`    | Print `{ org, project, environment }` (also the default when stdout is not a TTY). |

- **Confirmation.** In a terminal, you type the project slug (`cloud.projectSlug` in `poli-page.json`); anything else aborts and nothing is sent. Without a TTY the command needs `--yes` and otherwise exits `2`; `CI=true` does not stand in for `--yes` here.
- **Errors.** A developer gets `INSUFFICIENT_ROLE` (exit `5`, owner or admin required). A project that is not published in the environment (`PROJECT_NOT_IN_ENVIRONMENT`) or an environment the organization does not have (`ENVIRONMENT_NOT_FOUND`) exits `2`. While a publish or another removal of the same project and environment runs (`PUBLISH_IN_PROGRESS`), while the project is being transferred (`TRANSFER_IN_PROGRESS`), or when the environment is read-only (`ENVIRONMENT_READ_ONLY`), it exits `3`.

### Render

#### `poli render <spec>`

Render a template against the cloud engine. The `<spec>` is either the bare template `name` (the draft) or `name@<environment>` (what is published in that environment).

- **The draft** (`name`, or `name@draft`) renders through `POST /v1/render/draft` and needs a `poli login` session: an API key never renders the draft. The API answers the PDF itself, which the CLI writes locally. Nothing is stored, watermarked or counted, so there is no document and `--no-download` is refused.
- **An environment** (`name@<environment>`) renders through `POST /v1/render` with `environment: <environment>`. Every such render produces a stored document (api-spec §11.3): the CLI receives a JSON descriptor (`documentId`, `presignedPdfUrl`, `expiresAt`, `environment`, `diagnostics`, …), then fetches the URL and writes the PDF locally; pass `--no-download` to skip that step. With an API key, the environment must be the key's own; another one is refused before any call, naming the key's environment.

```bash
poli render invoice                                          # the draft (session), downloads PDF
poli render invoice@sandbox                                  # what is published in sandbox
poli render invoice@production --data ./mock.json            # an environment + custom data
poli render invoice -o ./out/invoice.pdf                     # custom path
poli render invoice@sandbox --no-download                    # JSON descriptor only
```

Spec rules:

- `name` → renders the draft (equivalent to `name@draft`).
- `name@<environment>` → an environment name: 1-20 characters, lowercase letters, digits and single inner hyphens, starting with a letter. `draft` is not an environment name: `name@draft` means the draft. Versions are gone: `name@1.2.3` and `name@latest` are refused with a pointer to `name@<environment>` (exit code `2`).

Flags:

- `--data <file>` — JSON data overrides the mock
- `-o <file>` — output PDF path. Incompatible with `--no-download`
- `--no-download` — skip the presigned URL fetch (CI/CD pipelines). Environment renders only
- `--json` — force JSON output even in a TTY

With `--json` (or piped), an environment render prints the API descriptor plus `outputPath`; a draft render, which has no descriptor, prints `{ "template", "environment": "draft", "outputPath" }`.

Errors:

- `404 PROJECT_NOT_IN_ENVIRONMENT` — the project was never published there: run `poli publish --env <environment>`. Exit code `2`.
- `404 ENVIRONMENT_NOT_FOUND` / `404 TEMPLATE_NOT_FOUND` — the environment does not exist, or the published copy has no such template. Exit code `2`.
- `503 PUBLISH_IN_PROGRESS` — a publish of that project and environment is running: the CLI waits `Retry-After` and retries once, then exits `3`.

[Output rules](#output-conventions) apply: in a TTY you see only the `✓` line, in a pipe you see only the JSON descriptor, with `--json` you always see the JSON. Pipelines stay clean:

```bash
$ DOC_ID=$(poli render invoice@sandbox | jq -r '.documentId')
$ poli documents thumbnails "$DOC_ID" --width 400
```

The success line (TTY) names what was rendered, and says `billed` when the render counts:

```
✓ Rendered invoice@production (billed) → ./output/invoice/a4-portrait/invoice.pdf
✓ Rendered invoice@sandbox → ./output/invoice/a4-portrait/invoice.pdf
✓ Rendered invoice@draft → ./output/invoice/a4-portrait/invoice.pdf
```

Counter:

- the draft → never counted
- `sandbox` → free, never counted (and the only watermarked environment)
- every other environment → counts in the monthly quota

### Documents

Documents are the cloud-stored output of every `poli render name@<environment>` invocation (or the same render endpoints called via the SDK or REST API); a draft render (`poli render name`) is never stored. The CLI lets you inspect, delete, and re-derive thumbnails or preview HTML from them.

There is intentionally **no `poli documents list`** — your application is responsible for tracking the `documentId` values it cares about.

#### `poli documents get <id>`

Returns the document JSON descriptor — the shape `poli render name@<environment>` prints, without the render's `diagnostics`. The summary shows the environment the document was rendered in. Output rules: in a TTY you see only the human-readable summary; in a pipe you see only the JSON descriptor; `--json` forces JSON. The CLI never downloads the PDF — `curl` the `presignedPdfUrl` or hand it to the browser yourself.

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
	},
	"fonts": [
		{
			"family": "Inter",
			"src": "assets/fonts/Inter.woff2",
			"weight": 400,
		},
	],
	"templates": [
		{
			"name": "invoice",
			"template": "templates/invoice/invoice.html",
			"mock": "templates/invoice/invoice.json",
			"format": "A4",
			"orientation": "portrait",
		},
	],
	"cloud": {
		"orgSlug": "acme",
		"orgId": "0e89d99e-1516-4b48-baa1-f49e660ad1c1",
		"projectSlug": "invoices",
		"projectId": "8274f64d-4ea2-4f96-b596-5727a7b17268",
	},
}
```

The `cloud:` block is written by `poli link`, removed by `poli unlink`. **No API keys here** — the credentials file (or `POLI_PAGE_API_KEY`) carries the secret.

A manifest from before environments may still carry `project.version` or `cloud.track`. Both are ignored, and dropped the next time the CLI writes the file (`poli link`, `poli unlink`, `poli new`).

---

## Configuration

### Environment variables

| Variable            | Effect                                                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POLI_PAGE_API_KEY` | Single env var for any API key in CI/CD: `pp_<environment>_` followed by 32 lowercase hex characters, checked in full before any call. The key renders only its own environment; a service key also publishes to it. **Precedence**: when a credentials file is also present, the session wins. |
| `POLI_API_URL`      | Override the API base URL (precedence: `--api-url` flag → `POLI_API_URL` → `poli-page.json` `cloud.apiUrl` → `~/.polipage/credentials.json` `apiUrl` → default `https://api.poli.page`).                                                                                                        |
| `NO_COLOR`          | Disable ANSI colors (Unix standard).                                                                                                                                                                                                                                                            |
| `CI`                | Auto-detected; equivalent to a global `--yes`, except for `poli env remove-project`.                                                                                                                                                                                                            |

### Common flags

- `--api-url <url>` — override the API base URL for one invocation
- `-y` / `--yes` — skip confirmation prompts
- `-h` / `--help` — show help for any command or sub-command
- `-v` / `--version` — print the CLI version and exit

### Output conventions

Every command that returns a payload (renders, descriptors, publishes) follows the same output rule:

| Context                                 | Stdout                 |
| --------------------------------------- | ---------------------- |
| TTY (interactive terminal), no `--json` | Human-readable summary |
| Pipe / redirect / CI (stdout not a TTY) | JSON                   |
| `--json` flag (any context)             | JSON                   |

Either the summary **or** the JSON — never both at once. Errors always go to stderr with a clear message.

Commands that take this contract: `render`, `documents get`, `documents preview`, `documents thumbnails`, `whoami`, `publish`, `env list`, `env remove-project`, `init --starter`.

Imperative commands (`init` without `--starter`, `new`, `link`, `unlink`, `logout`, `documents delete`, `watch`, `login`) don't have a JSON payload to forward — they just acknowledge with a `✓` line on success.

---

## Exit codes

| Code | Meaning                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Success                                                                                                                        |
| `1`  | Recoverable inconsistency (already logged in, already linked)                                                                  |
| `2`  | Invalid usage (bad args, template not found, project not published in that environment, non-TTY context where TTY is required) |
| `3`  | Network / API error (timeout, 5xx, unspecified 4xx)                                                                            |
| `4`  | Not authenticated — run `poli login` or set `POLI_PAGE_API_KEY`                                                                |
| `5`  | Not authorized (insufficient role, protected environment, `THUMBNAILS_NOT_AVAILABLE`)                                          |
| `6`  | Invalid local state (no project, project not linked, empty folder where required)                                              |

These map to the centralised `ExitCode` constants in `src/exit-codes.ts`. Every handler routes errors through `errorToExitCode(err)`.

---

## CI / CD

### Publish from CI with a service key

```yaml
# .github/workflows/publish.yml
name: Publish templates

on:
    push:
        branches: [main]

jobs:
    publish:
        runs-on: ubuntu-latest
        env:
            POLI_PAGE_API_KEY: ${{ secrets.POLI_PAGE_SERVICE_KEY }} # a service key for `live`
        steps:
            - uses: actions/checkout@v4
            - uses: actions/setup-node@v4
              with:
                  node-version: '22'
            - run: npm install -g @poli-page/cli
            - run: poli publish --env live -m "Deploy ${{ github.sha }}"
```

The workflow runs in the linked project folder (the one with `poli-page.json` and its `cloud` block). The key decides the environment: `--env` must name it. `live` is protected, so the service key needs the `admin` role.

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
            - run: poli render invoice@live -o ./artifacts/invoice.pdf
            - uses: actions/upload-artifact@v4
              with:
                  name: invoice-pdf
                  path: ./artifacts/invoice.pdf
```

The key decides the environment: a `pp_live_…` key renders `invoice@live` and nothing else. A standard key is enough to render; a service key also works, and rotating either one does not log out any developer.

### GitLab CI

```yaml
render:
    image: node:22-alpine
    variables:
        POLI_PAGE_API_KEY: $POLI_PAGE_API_KEY
    script:
        - npm install -g @poli-page/cli
        - poli render invoice@live -o invoice.pdf
    artifacts:
        paths:
            - invoice.pdf
```

### Vercel / Netlify build hook

```bash
# In a build script
npm install -g @poli-page/cli
POLI_PAGE_API_KEY=pp_live_xxx poli render homepage-pdf@live -o ./public/welcome.pdf
```

A service key has a **fixed role and environment** from its creation. The CLI does not try to switch them — the API enforces the permissions.

---

## Troubleshooting

### `Not logged in. Run \`poli login\` or set POLI_PAGE_API_KEY.`

Either run `poli login` interactively, or export `POLI_PAGE_API_KEY` for CI use. Exit code `4`.

### `POLI_PAGE_API_KEY must be a Poli Page API key: \`pp_<environment>_…\`...`

You set the variable but its value is not a whole key: `pp_`, the environment name, `_`, then 32 lowercase hex characters. Copy the key again, or create one from the dashboard's API keys page. Exit code `4`.

### `Standard API keys can only render. Use a service key or \`poli login\`.`

`poli publish` with `POLI_PAGE_API_KEY` set to a standard key. Only a service key, or a `poli login` session, can publish. Exit code `5`.

### `This service key publishes to "<a>" only, not "<b>"...`

A service key publishes into its own environment only. Pass `--env <a>`, or use a service key for `<b>`. Exit code `2`.

### `This folder isn't linked to a cloud project. Run \`poli link\` first.`

You're in session mode and the local manifest has no `cloud:` block. Either run `poli link`, or switch to api-key mode with `POLI_PAGE_API_KEY=pp_<environment>_…` (which carries the org context implicitly). Exit code `6`.

### `API keys render a published environment: use \`name@<environment>\``

`poli render name` renders the draft, which only a `poli login` session can do. With an API key, render the key's environment: `poli render name@<environment>`. Exit code `2`.

### `This API key renders the \`<a>\` environment, not \`<b>\``

A key renders only the environment in its prefix. Render `name@<a>`, or use a key for `<b>`. Exit code `2`.

### `\`invoice@1.2.3\`: templates no longer have versions...`

Render specs name an environment, not a version: `poli render invoice@<environment>`, or `poli render invoice` for the draft. Exit code `2`.

### `403 DRAFT_REQUIRES_SESSION`

The API renders the draft for a `poli login` session only. The CLI refuses a draft render with an API key before any call (see above), so this code comes back only from a draft render sent outside the CLI with a key. Render `name@<environment>` with the key, or render the draft after `poli login`.

### `Environment "<env>" is protected...` (`403 ENVIRONMENT_PROTECTED`)

`poli publish --env <env>` to a protected environment (`live` by default) by someone who is not an owner or admin of the organization, or with a service key without the `admin` role. Ask an owner or admin to publish, or use an `admin` service key. Exit code `5`.

Without a terminal, `Environment "<env>" is protected. Pass --yes to publish to it without a prompt.` means the confirmation could not be asked: pass `--yes` (`CI=true` counts as `--yes`). Exit code `2`.

### `PUBLISH_IN_PROGRESS`

A publish of the same project and environment is running. `poli render name@<env>` gets `503 PUBLISH_IN_PROGRESS`, waits `Retry-After` and retries once; if the publish is still running, it exits `3`: try again in a moment. `poli publish` and `poli env remove-project` get it while another publish or removal runs, and do not retry: run the command again once the other one is done. Exit code `3`.

### `403 THUMBNAILS_NOT_AVAILABLE`

Thumbnails via `poli documents thumbnails` are a paid-tier feature. Upgrade to Starter from the dashboard. Exit code `5`.

### `429 OVERAGE_CAP_EXCEEDED`

Your org has crossed the monthly cap on `live` PDF renders (counted across `poli render` in any environment other than `sandbox` and `poli documents thumbnails` on a document of such an environment). Wait until the next billing period or raise the cap from your dashboard. Exit code `3`.

### `503 ORGANIZATION_MIGRATING`

Your org is being migrated to a new tier. `poli watch` retries automatically after 5s. Other commands surface the error — retry by hand once the migration completes (typically under a minute).

### `poli watch` doesn't fire on save

Make sure you're not editing inside an ignored directory. Default ignores: `node_modules/`, `.git/`, `output/`, `dist/`, `*.log`, `.DS_Store`. The watcher uses `chokidar` v5; if your editor saves via "atomic write + rename" (some Vim setups), the rename event fires within the debounce window and triggers a sync.

---

## License

MIT — see [LICENSE](LICENSE).

## Links

- [Documentation](https://docs.poli.page)
- [Dashboard](https://app.poli.page)
- [Issue tracker](https://github.com/poli-page/cli/issues)
- [Changelog](CHANGELOG.md)
