import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Repo Docs MCP (Bun) — generic MCP server (repo docs + code).
 *
 * Transport entrypoints live in:
 * - src/index.ts (stdio)
 * - src/http.ts (Streamable HTTP)
 */

function parseCommaList(value: string | undefined, fallback: string[]): string[] {
  const v = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return v.length ? v : fallback;
}

function sanitizeToolPrefix(prefix: string): string {
  // Keep it predictable: [a-zA-Z_][a-zA-Z0-9_]*
  const cleaned = prefix
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
  if (!cleaned) return "repo";
  if (!/^[a-zA-Z_]/.test(cleaned)) return `repo_${cleaned}`;
  return cleaned;
}

function sanitizeScheme(scheme: string): string {
  // RFC-ish: start with a letter, then [a-z0-9+.-]
  let s = scheme.trim().toLowerCase().replace(/_/g, "-");
  s = s.replace(/[^a-z0-9+.-]/g, "-").replace(/-+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  if (!s) return "repo";
  if (!/^[a-z]/.test(s)) s = `repo-${s}`;
  return s;
}

// ---- Config (env) ----

// Prefer MCP_REPO_ROOT; keep MCP_TELEGRAPH_ROOT as a legacy fallback.
const REPO_ROOT = path.resolve(process.env.MCP_REPO_ROOT ?? process.env.MCP_TELEGRAPH_ROOT ?? process.cwd());

const TOOL_PREFIX = sanitizeToolPrefix(process.env.MCP_TOOL_PREFIX ?? "repo");
const URI_SCHEME = sanitizeScheme(process.env.MCP_URI_SCHEME ?? TOOL_PREFIX);
const REPO_LABEL = (process.env.MCP_REPO_LABEL ?? path.basename(REPO_ROOT) ?? TOOL_PREFIX).trim();

const DOCS_DIR = (process.env.MCP_DOCS_DIR ?? "docs").trim();
const DOCS_EXTS = parseCommaList(process.env.MCP_DOCS_EXTS, [".md", ".mdx"]).map((e) => e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`);

const CODE_DIRS = parseCommaList(process.env.MCP_CODE_DIRS, ["src", "config", "routes", "database", "resources", "tests"]).map((d) => d.trim()).filter(Boolean);
const CODE_EXTS = parseCommaList(process.env.MCP_CODE_EXTS, [".php", ".md", ".json", ".yml", ".yaml", ".xml", ".ts", ".js"]).map((e) => e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`);

const MAX_FILE_BYTES = Number(process.env.MCP_MAX_FILE_BYTES ?? 512 * 1024); // 512KB
const DEFAULT_MAX_CHARS = Number(process.env.MCP_DEFAULT_MAX_CHARS ?? 50_000);

export const SERVER_NAME = (process.env.MCP_SERVER_NAME ?? `${TOOL_PREFIX}-docs`).trim();
export const SERVER_VERSION = (process.env.MCP_SERVER_VERSION ?? "0.2.0").trim();

export const AUTO_GIT_FETCH = String(process.env.MCP_GIT_AUTO_FETCH ?? "").trim() === "1";
const GIT_FETCH_TIMEOUT_MS = Number(process.env.MCP_GIT_FETCH_TIMEOUT_MS ?? 30_000);

function toolName(suffix: string): string {
  return `${TOOL_PREFIX}_${suffix}`;
}

function uri(pathPart: string): string {
  return `${URI_SCHEME}://${pathPart.replace(/^\/+/, "")}`;
}

// ---- Helpers (filesystem) ----

type DocMeta = { slug: string; relPath: string; title?: string };
let docIndex: DocMeta[] | null = null;
let slugToRelPath: Map<string, string> | null = null;

function stripOrderingPrefix(segment: string): string {
  // Remove ordering prefixes like:
  // - 12.features
  // - 01-introduction
  // - 3_getting-started
  return segment.replace(/^\d+([._-])/, "");
}

function inferSlugFromDocRelPath(docRelPath: string): string {
  const parts = docRelPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length === 0) return "";

  const ext = DOCS_EXTS.find((e) => parts[parts.length - 1].toLowerCase().endsWith(e));
  const fileRaw = parts[parts.length - 1];
  const fileBaseRaw = ext ? fileRaw.slice(0, -ext.length) : fileRaw.replace(/\.[^.]+$/i, "");

  const dirParts = parts.slice(0, -1).map((p) => stripOrderingPrefix(p));
  const fileBase = stripOrderingPrefix(fileBaseRaw);

  const isFolderIndex = (name: string) => {
    const n = name.toLowerCase();
    return n === "index" || n === "readme";
  };

  const slugParts: string[] = [...dirParts];
  if (!(dirParts.length > 0 && isFolderIndex(fileBase))) {
    slugParts.push(fileBase);
  }

  return slugParts.filter(Boolean).join("/");
}

function extractTitleFromFrontmatter(text: string): string | undefined {
  if (!text.startsWith("---")) return undefined;
  const match = text.match(/^---([\s\S]*?)---/);
  if (!match) return undefined;

  const fm = match[1];
  const titleMatch =
    fm.match(/title:\s*'([^']+)'/) ||
    fm.match(/title:\s*\"([^\"]+)\"/) ||
    fm.match(/title:\s*([^\n\r]+)/);

  const raw = titleMatch?.[1]?.trim();
  return raw ? raw.replace(/\s+/g, " ").trim() : undefined;
}

function cleanDocText(text: string): string {
  // Keep Telegraph-friendly cleanup (harmless for other repos)
  return text.replace(/\[replace:[^\]]+\]/g, "").trim();
}

function isSubpath(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function safeJoin(root: string, rel: string): string {
  const cleaned = rel.replace(/^([/\\])+/, "");
  const resolved = path.resolve(root, cleaned);
  if (resolved !== root && !isSubpath(resolved, root)) {
    throw new Error(`Unsafe path: ${rel}`);
  }
  return resolved;
}

async function walkFiles(dirAbs: string, filter: (abs: string) => boolean): Promise<string[]> {
  const out: string[] = [];

  async function rec(d: string) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        await rec(abs);
      } else if (e.isFile()) {
        if (filter(abs)) out.push(abs);
      }
    }
  }

  await rec(dirAbs);
  return out;
}

async function readTextFile(absPath: string, maxChars = DEFAULT_MAX_CHARS): Promise<string> {
  const st = await fs.stat(absPath);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`File too large (${st.size} bytes): ${absPath}`);
  }

  const buf = await fs.readFile(absPath);
  const text = buf.toString("utf8");
  if (text.includes("\u0000")) throw new Error("Binary file not supported");

  if (text.length > maxChars) {
    return text.slice(0, maxChars) + "\n\n…(truncated)";
  }
  return text;
}

async function buildDocIndex(): Promise<DocMeta[]> {
  if (docIndex && slugToRelPath) return docIndex;

  const docsDirAbs = safeJoin(REPO_ROOT, DOCS_DIR);

  // If docs directory doesn't exist, just index empty.
  let st: any;
  try {
    st = await fs.stat(docsDirAbs);
  } catch {
    docIndex = [];
    slugToRelPath = new Map();
    return docIndex;
  }
  if (!st.isDirectory()) {
    docIndex = [];
    slugToRelPath = new Map();
    return docIndex;
  }

  const files = await walkFiles(docsDirAbs, (abs) => DOCS_EXTS.some((e) => abs.toLowerCase().endsWith(e)));

  const metas: DocMeta[] = [];
  const map = new Map<string, string>();

  for (const abs of files) {
    const rel = path.relative(docsDirAbs, abs).replace(/\\/g, "/");
    const slug = inferSlugFromDocRelPath(rel);

    let title: string | undefined;
    try {
      const head = await readTextFile(abs, 10_000);
      title = extractTitleFromFrontmatter(head);
    } catch {
      // ignore
    }

    metas.push({ slug, relPath: rel, title });
    map.set(slug, rel);
  }

  metas.sort((a, b) => a.slug.localeCompare(b.slug));
  docIndex = metas;
  slugToRelPath = map;
  return metas;
}

async function searchInFiles(
  baseAbsDir: string,
  exts: string[],
  query: string,
  maxResults: number
): Promise<Array<{ file: string; line: number; snippet: string }>> {
  const q = query.toLowerCase();
  const files = await walkFiles(baseAbsDir, (abs) => exts.some((e) => abs.toLowerCase().endsWith(e)));

  const results: Array<{ file: string; line: number; snippet: string }> = [];

  for (const abs of files) {
    if (results.length >= maxResults) break;

    let text: string;
    try {
      text = await readTextFile(abs, 200_000);
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= maxResults) break;
      if (lines[i].toLowerCase().includes(q)) {
        const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, "/");
        results.push({ file: rel, line: i + 1, snippet: lines[i].trim().slice(0, 320) });
      }
    }
  }

  return results;
}

// ---- Git helper ----

export function runGitFetch(): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", REPO_ROOT, "fetch", "--prune", "--tags"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: { ok: boolean; code: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      resolve({
        ...result,
        stdout: (result.stdout ?? "").trim(),
        stderr: (result.stderr ?? "").trim(),
      });
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish({
        ok: false,
        code: null,
        stdout,
        stderr: stderr || `git fetch timed out after ${GIT_FETCH_TIMEOUT_MS}ms`,
      });
    }, GIT_FETCH_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));

    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, code, stdout, stderr });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, code: null, stdout: "", stderr: String(err) });
    });
  });
}

// ---- MCP server ----

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerAll(server);

  return server;
}

function registerAll(server: McpServer): void {

/**
 * TOOLS
 */

server.registerTool(
  toolName("read_repo_file"),
  {
    title: `${REPO_LABEL}: read repo file`,
    description: "Read a text file from the local repository checkout (path relative to repo root).",
    inputSchema: {
      path: z.string().min(1).describe("Relative path inside the repo root, e.g. README.md or src/Foo.php"),
      maxChars: z.number().int().min(1000).max(250000).optional().describe("Max chars to return."),
    },
  },
  async ({ path: relPath, maxChars }) => {
    try {
      const abs = safeJoin(REPO_ROOT, relPath);
      const text = await readTextFile(abs, maxChars ?? DEFAULT_MAX_CHARS);
      return { content: [{ type: "text", text }] };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
      };
    }
  }
);

server.registerTool(
  toolName("list_docs"),
  {
    title: `${REPO_LABEL}: list docs`,
    description: `List documentation pages under ${DOCS_DIR}/ as \"slug -> file\" (slug inferred from file path).`,
    inputSchema: {
      contains: z.string().optional().describe("Optional substring filter (matches slug/title)."),
      max: z.number().int().min(1).max(2000).optional().describe("Max items, default 200."),
    },
  },
  async ({ contains, max }) => {
    try {
      const metas = await buildDocIndex();
      const limit = max ?? 200;
      const needle = contains?.toLowerCase();

      const filtered = needle
        ? metas.filter((m) => `${m.slug} ${m.title ?? ""}`.toLowerCase().includes(needle))
        : metas;

      return { content: [{ type: "text", text: JSON.stringify(filtered.slice(0, limit), null, 2) }] };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
      };
    }
  }
);

server.registerTool(
  toolName("get_doc"),
  {
    title: `${REPO_LABEL}: get doc page`,
    description: "Get a doc page by slug (preferred) or relPath (relative to docs dir).",
    inputSchema: {
      slug: z.string().optional().describe("Doc slug, e.g. webhooks/overview or introduction"),
      relPath: z.string().optional().describe(`Relative path inside ${DOCS_DIR}/, e.g. guide/overview.md`),
      maxChars: z.number().int().min(1000).max(250000).optional().describe("Max chars to return."),
    },
  },
  async ({ slug, relPath, maxChars }) => {
    try {
      if (!slug && !relPath) {
        return { isError: true, content: [{ type: "text", text: "Provide either slug or relPath" }] };
      }

      await buildDocIndex();
      const map = slugToRelPath ?? new Map();

      const rel = relPath ?? (slug ? map.get(slug) : undefined);
      if (!rel) {
        return { isError: true, content: [{ type: "text", text: `Not found: ${slug ?? relPath}` }] };
      }

      const docsDirAbs = safeJoin(REPO_ROOT, DOCS_DIR);
      const abs = safeJoin(docsDirAbs, rel);
      const raw = await readTextFile(abs, maxChars ?? DEFAULT_MAX_CHARS);
      const cleaned = cleanDocText(raw);

      return { content: [{ type: "text", text: cleaned }] };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
      };
    }
  }
);

server.registerTool(
  toolName("search_docs"),
  {
    title: `${REPO_LABEL}: search docs`,
    description: `Search a text query inside ${DOCS_DIR}/ files.`,
    inputSchema: {
      query: z.string().min(2).describe("Search query"),
      maxResults: z.number().int().min(1).max(500).optional().describe("Max results, default 20."),
    },
  },
  async ({ query, maxResults }) => {
    try {
      const docsDirAbs = safeJoin(REPO_ROOT, DOCS_DIR);
      const results = await searchInFiles(docsDirAbs, DOCS_EXTS, query, maxResults ?? 20);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
      };
    }
  }
);

server.registerTool(
  toolName("search_code"),
  {
    title: `${REPO_LABEL}: search code`,
    description: "Search a text query inside common code directories.",
    inputSchema: {
      query: z.string().min(2).describe("Search query"),
      maxResults: z.number().int().min(1).max(1000).optional().describe("Max results, default 30."),
      includeDocs: z.boolean().optional().describe("Also search docs dir (default false)."),
    },
  },
  async ({ query, maxResults, includeDocs }) => {
    try {
      const dirs = [...CODE_DIRS];
      if (includeDocs) dirs.push(DOCS_DIR);

      const collected: Array<{ file: string; line: number; snippet: string }> = [];
      const limit = maxResults ?? 30;

      for (const d of dirs) {
        if (collected.length >= limit) break;

        const dirAbs = safeJoin(REPO_ROOT, d);
        const st = await fs.stat(dirAbs).catch(() => null);
        if (!st || !st.isDirectory()) continue;

        const res = await searchInFiles(dirAbs, CODE_EXTS, query, limit - collected.length);
        collected.push(...res);
      }

      return { content: [{ type: "text", text: JSON.stringify(collected, null, 2) }] };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
      };
    }
  }
);

server.registerTool(
  toolName("refresh_index"),
  {
    title: `${REPO_LABEL}: refresh docs index`,
    description: "Re-scan docs and rebuild the in-memory slug index.",
    inputSchema: {},
  },
  async () => {
    docIndex = null;
    slugToRelPath = null;
    const metas = await buildDocIndex();
    return { content: [{ type: "text", text: `OK: indexed ${metas.length} doc files` }] };
  }
);

server.registerTool(
  toolName("git_fetch"),
  {
    title: `${REPO_LABEL}: git fetch`,
    description: "Run 'git fetch --prune --tags' in the repo (updates remote refs; does NOT change your working tree).",
    inputSchema: {},
  },
  async () => {
    const res = await runGitFetch();
    const text = JSON.stringify(
      {
        ok: res.ok,
        code: res.code,
        stdout: res.stdout,
        stderr: res.stderr,
      },
      null,
      2
    );
    return res.ok ? { content: [{ type: "text", text }] } : { isError: true, content: [{ type: "text", text }] };
  }
);

server.registerTool(
  toolName("info"),
  {
    title: `${REPO_LABEL}: server info`,
    description: "Show server settings (repo root, docs dir, prefixes, etc.).",
    inputSchema: {},
  },
  async () => {
    const info = {
      server: { name: SERVER_NAME, version: SERVER_VERSION },
      repo: { root: REPO_ROOT, label: REPO_LABEL },
      naming: { toolPrefix: TOOL_PREFIX, uriScheme: URI_SCHEME },
      docs: { dir: DOCS_DIR, exts: DOCS_EXTS },
      codeSearch: { dirs: CODE_DIRS, exts: CODE_EXTS },
      limits: { maxFileBytes: MAX_FILE_BYTES, defaultMaxChars: DEFAULT_MAX_CHARS },
      git: { autoFetchOnStart: AUTO_GIT_FETCH },
    };
    return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
  }
);

/**
 * RESOURCES
 */

server.registerResource(
  "readme",
  uri("readme"),
  { title: `${REPO_LABEL} README`, mimeType: "text/markdown" },
  async () => {
    const candidates = ["README.md", "readme.md", "README.MD"]; // basic
    let found: string | null = null;
    for (const c of candidates) {
      const abs = safeJoin(REPO_ROOT, c);
      const st = await fs.stat(abs).catch(() => null);
      if (st?.isFile()) {
        found = c;
        break;
      }
    }

    if (!found) {
      return {
        contents: [{ uri: uri("readme"), mimeType: "text/plain", text: "README not found" }],
      };
    }

    const abs = safeJoin(REPO_ROOT, found);
    const text = await readTextFile(abs);
    return { contents: [{ uri: uri("readme"), mimeType: "text/markdown", text }] };
  }
);

server.registerResource(
  "contributing",
  uri("contributing"),
  { title: `${REPO_LABEL} CONTRIBUTING`, mimeType: "text/markdown" },
  async () => {
    const candidates = [".github/CONTRIBUTING.md", "CONTRIBUTING.md", "contributing.md"]; // common
    let found: string | null = null;
    for (const c of candidates) {
      const abs = safeJoin(REPO_ROOT, c);
      const st = await fs.stat(abs).catch(() => null);
      if (st?.isFile()) {
        found = c;
        break;
      }
    }

    if (!found) {
      return {
        contents: [{ uri: uri("contributing"), mimeType: "text/plain", text: "CONTRIBUTING not found" }],
      };
    }

    const abs = safeJoin(REPO_ROOT, found);
    const text = await readTextFile(abs);
    return { contents: [{ uri: uri("contributing"), mimeType: "text/markdown", text }] };
  }
);

server.registerResource(
  "doc",
  new ResourceTemplate(uri("doc/{slug}"), {
    list: undefined,
    complete: {
      slug: async (value) => {
        const metas = await buildDocIndex();
        const v = (value ?? "").toLowerCase();
        return metas
          .map((m) => m.slug)
          .filter((s) => s.toLowerCase().includes(v))
          .slice(0, 50);
      },
    },
  }),
  { title: `${REPO_LABEL} doc page`, mimeType: "text/markdown" },
  async (resourceUri, { slug }) => {
    await buildDocIndex();
    const rel = (slugToRelPath ?? new Map()).get(String(slug));

    if (!rel) {
      return {
        contents: [{ uri: String(resourceUri), mimeType: "text/plain", text: `Not found: ${String(slug)}` }],
      };
    }

    const docsDirAbs = safeJoin(REPO_ROOT, DOCS_DIR);
    const abs = safeJoin(docsDirAbs, rel);
    const raw = await readTextFile(abs);
    const text = cleanDocText(raw);

    return { contents: [{ uri: String(resourceUri), mimeType: "text/markdown", text }] };
  }
);

/**
 * PROMPTS
 */

server.registerPrompt(
  toolName("doc_writer"),
  {
    title: `${REPO_LABEL}: doc writer`,
    description: "Start a repo-aware workflow for writing guides or answers about this repository.",
    argsSchema: {
      goal: z.string().describe("What you want to write / explain / build"),
    },
  },
  async ({ goal }) => {
    return {
      title: `${REPO_LABEL}: doc writer`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `You are helping with a repository.\n\n` +
              `Repository: ${REPO_LABEL}\n` +
              `Goal: ${goal}\n\n` +
              `Rules:\n` +
              `- Use the repository docs and code as the source of truth.\n` +
              `- When unsure, call tools: ${toolName("search_docs")}, ${toolName("get_doc")}, ${toolName("search_code")}, ${toolName("read_repo_file")}.\n` +
              `- Prefer concrete, copy-pastable examples and mention file paths when referencing code.\n` +
              `- If a step depends on version/configuration, say how to verify it in the repo.\n`,
          },
        },
      ],
    };
  }
);

}

export function logStartup(transportLabel: string): void {
  console.error(`${SERVER_NAME} MCP server running (${transportLabel})`);
  console.error(`MCP_REPO_ROOT=${REPO_ROOT}`);
  console.error(`MCP_TOOL_PREFIX=${TOOL_PREFIX}`);
  console.error(`MCP_URI_SCHEME=${URI_SCHEME}`);
  console.error(`MCP_DOCS_DIR=${DOCS_DIR}`);
}

export function maybeAutoGitFetch(): void {
  if (!AUTO_GIT_FETCH) {
    return;
  }

  // Fire-and-forget: doesn't block startup.
  runGitFetch()
    .then((res) => {
      if (res.ok) console.error(`[git fetch] ok`);
      else console.error(`[git fetch] failed: ${res.stderr || "unknown error"}`);
    })
    .catch((e) => console.error(`[git fetch] error: ${String(e)}`));
}
