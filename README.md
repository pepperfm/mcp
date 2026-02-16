# Repo Docs MCP (Bun)

Generic **MCP stdio server** that exposes a **local repository checkout** (docs + code) to any MCP host.

Designed for the “one codebase, many instances” workflow:
- you run the same server binary multiple times,
- each instance points at a different repo via env,
- each instance gets its own tool prefix + URI scheme.

## What it provides

### Tools (names are prefixed)
Given `MCP_TOOL_PREFIX=telegraph`, tools are:
- `telegraph_read_repo_file` — read any text file from the repo checkout
- `telegraph_list_docs` — list doc pages as `slug -> docs/...` (slug is inferred from the docs file path)
- `telegraph_get_doc` — read a doc page by slug
- `telegraph_search_docs` — search inside the docs directory
- `telegraph_search_code` — search inside common code directories
- `telegraph_refresh_index` — rebuild the docs index
- `telegraph_git_fetch` — `git fetch --prune --tags` for the repo (optional helper)
- `telegraph_info` — print server settings (paths, prefixes, etc.)

### Resources (names are prefixed by URI scheme)
Given `MCP_URI_SCHEME=telegraph`, resources are:
- `telegraph://readme`
- `telegraph://contributing`
- `telegraph://doc/{slug}`

### Prompts
- `{prefix}_doc_writer` — starter workflow for “write a guide / answer about this repo”.

## Install

```bash
bun install
bun run build
```

## Run (stdio)

```bash
MCP_REPO_ROOT=/ABS/PATH/to/repo \
MCP_TOOL_PREFIX=myrepo \
MCP_URI_SCHEME=myrepo \
bun run start
```

> In stdio mode, logs go to **stderr** on purpose (stdout is reserved for MCP JSON-RPC).

## Environment variables

Required:
- `MCP_REPO_ROOT` — absolute path to the local repo checkout

Optional:
- `MCP_TOOL_PREFIX` — tool name prefix (default: `repo`)
- `MCP_URI_SCHEME` — resource URI scheme (default: derived from tool prefix)
- `MCP_REPO_LABEL` — text label used in the prompt (default: basename of repo root)
- `MCP_DOCS_DIR` — docs directory relative to repo root (default: `docs`)
- `MCP_DOCS_EXTS` — comma-separated docs extensions (default: `.md,.mdx`)
- `MCP_CODE_DIRS` — comma-separated dirs to search for code (default: `src,config,routes,database,resources,tests`)
- `MCP_CODE_EXTS` — comma-separated extensions for code search (default: `.php,.md,.json,.yml,.yaml,.xml,.ts,.js`)

Limits:
- `MCP_MAX_FILE_BYTES` (default: 512KB)
- `MCP_DEFAULT_MAX_CHARS` (default: 50k chars)

Git helper:
- `MCP_GIT_AUTO_FETCH=1` — run `git fetch --prune --tags` once at server start (default: off)
- `MCP_GIT_FETCH_TIMEOUT_MS` — timeout for the fetch command (default: 30000)

Compatibility:
- If `MCP_REPO_ROOT` is not set, the server will fall back to `MCP_TELEGRAPH_ROOT` (legacy name).

## Codex config (two instances; one codebase)

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.telegraph_docs]
command = "/ABS/PATH/TO/bun"
cwd = "/ABS/PATH/TO/repo-docs-mcp-bun"
args = ["run", "build/index.js"]

[mcp_servers.telegraph_docs.env]
MCP_REPO_ROOT = "/ABS/PATH/TO/telegraph"
MCP_TOOL_PREFIX = "telegraph"
MCP_URI_SCHEME = "telegraph"
MCP_REPO_LABEL = "defstudio/telegraph"


[mcp_servers.laravel_data_docs]
command = "/ABS/PATH/TO/bun"
cwd = "/ABS/PATH/TO/repo-docs-mcp-bun"
args = ["run", "build/index.js"]

[mcp_servers.laravel_data_docs.env]
MCP_REPO_ROOT = "/ABS/PATH/TO/laravel-data"
MCP_TOOL_PREFIX = "laravel_data"
MCP_URI_SCHEME = "laravel-data"
MCP_REPO_LABEL = "spatie/laravel-data"
```

## Claude Desktop config (two instances)

See `claude_desktop_config.example.json`.

## Notes

- Docs slugs are inferred from file paths (ordering prefixes like `01.`, `01-`, `01_` are stripped).
- If a doc file is `index.md` inside a folder, the slug is the folder name (e.g. `guide/index.md` → `guide`).
