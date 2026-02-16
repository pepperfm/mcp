import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { logStartup, maybeAutoGitFetch, server } from "./server.js";

const HOST = (process.env.HOST ?? "127.0.0.1").trim();
const PORT = Number(process.env.PORT ?? "4010");
const ENDPOINT_PATH = (process.env.MCP_ENDPOINT_PATH ?? "/mcp").trim() || "/mcp";

if (!Number.isFinite(PORT) || PORT <= 0) {
  throw new Error(`Invalid PORT: ${String(process.env.PORT)}`);
}

async function main(): Promise<void> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await server.connect(transport);

  Bun.serve({
    hostname: HOST,
    port: PORT,
    fetch(req: Request): Promise<Response> | Response {
      const url = new URL(req.url);

      if (url.pathname !== ENDPOINT_PATH) {
        return new Response("Not Found", { status: 404 });
      }

      return transport.handleRequest(req);
    },
  });

  logStartup(`http ${HOST}:${PORT}${ENDPOINT_PATH}`);
  maybeAutoGitFetch();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

