import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, logStartup, maybeAutoGitFetch } from "./server.js";

const HOST = (process.env.HOST ?? "127.0.0.1").trim();
const PORT = Number(process.env.PORT ?? "4010");
const ENDPOINT_PATH = (process.env.MCP_ENDPOINT_PATH ?? "/mcp").trim() || "/mcp";

if (!Number.isFinite(PORT) || PORT <= 0) {
  throw new Error(`Invalid PORT: ${String(process.env.PORT)}`);
}

type Transport = WebStandardStreamableHTTPServerTransport;

const transports = new Map<string, Transport>();

function jsonError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

function isInitializeBody(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.length === 1 && isInitializeRequest(body[0]);
  }

  return isInitializeRequest(body);
}

async function main(): Promise<void> {
  Bun.serve({
    hostname: HOST,
    port: PORT,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname !== ENDPOINT_PATH) {
        return new Response("Not Found", { status: 404 });
      }

      const sessionId = req.headers.get("mcp-session-id") ?? undefined;
      const existing = sessionId ? transports.get(sessionId) : undefined;

      if (req.method === "POST") {
        let parsedBody: unknown;
        try {
          parsedBody = await req.json();
        } catch {
          return jsonError(400, -32700, "Parse error: Invalid JSON");
        }

        if (existing) {
          return existing.handleRequest(req, { parsedBody });
        }

        if (!sessionId && isInitializeBody(parsedBody)) {
          let transport: Transport;
          transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, transport);
            },
            onsessionclosed: (sid) => {
              if (sid) {
                transports.delete(sid);
              }
            },
          });

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) {
              transports.delete(sid);
            }
          };

          const server = createServer();
          await server.connect(transport);

          return transport.handleRequest(req, { parsedBody });
        }

        return jsonError(400, -32000, "Bad Request: No valid session ID provided");
      }

      if (!existing) {
        return jsonError(400, -32000, "Bad Request: Invalid or missing session ID");
      }

      return existing.handleRequest(req);
    },
  });

  logStartup(`http ${HOST}:${PORT}${ENDPOINT_PATH}`);
  maybeAutoGitFetch();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
