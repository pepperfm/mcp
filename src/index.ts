import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, logStartup, maybeAutoGitFetch } from "./server.js";

/**
 * Stdio transport entrypoint.
 *
 * IMPORTANT:
 * - never write anything to stdout (console.log)
 * - log only to stderr (console.error)
 */

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logStartup("stdio");
  maybeAutoGitFetch();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
