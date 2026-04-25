# Poli Page CLI

[![npm version](https://img.shields.io/npm/v/@poli-page/cli.svg)](https://www.npmjs.com/package/@poli-page/cli)
[![license](https://img.shields.io/npm/l/@poli-page/cli.svg)](LICENSE)

Command-line tool for [Poli Page](https://poli.page) — scaffold projects, create templates, and render PDFs from the terminal.

## Install

```bash
npm install -g @poli-page/cli
# or
pnpm add -g @poli-page/cli
```

Requires Node.js 22 or later.

## Quick start

```bash
# Authenticate (opens browser for device flow)
poli login

# Scaffold a new project
poli init my-invoices
cd my-invoices

# Create a template from a layout model
poli new invoice --model header-main-footer

# Link the project to your Poli Page organization
poli link

# Render a PDF
poli render invoice -o invoice.pdf
```

## Commands

| Command                          | Description                               |
| -------------------------------- | ----------------------------------------- |
| `poli init <name>`               | Scaffold a new project                    |
| `poli new <name>`                | Create a template from a layout model     |
| `poli render <name>`             | Generate a PDF from a template            |
| `poli thumbnail <name>`          | Generate thumbnail images from a template |
| `poli login`                     | Authenticate via device flow              |
| `poli logout`                    | Clear local credentials                   |
| `poli whoami`                    | Show current user and organizations       |
| `poli link`                      | Link the project to a cloud organization  |
| `poli unlink`                    | Remove the cloud association              |
| `poli publish`                   | Sync and publish a new version            |
| `poli versions list`             | List published versions                   |
| `poli versions download <ver>`   | Download a published version              |

Run `poli <command> --help` for full options.

## Configuration

| Option             | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `--api-url <url>`  | Override the API base URL (precedence over `POLI_API_URL`).          |
| `-v, --version`    | Display the CLI version.                                             |

Environment variables:

| Variable        | Default                  | Description    |
| --------------- | ------------------------ | -------------- |
| `POLI_API_URL`  | `https://api.poli.page`  | API base URL   |

The API URL is resolved in this order: `--api-url` flag → `POLI_API_URL` env var → `poli-page.json` (`cloud.apiUrl`) → `~/.polipage/credentials.json` (`apiUrl`) → default.

## Credentials

Credentials are stored in `~/.polipage/credentials.json`. The file holds the session token and per-organization API keys. The file is never committed.

## Documentation

Full documentation: [docs.poli.page](https://docs.poli.page)

## License

[MIT](LICENSE) © Xavier Pourrier
