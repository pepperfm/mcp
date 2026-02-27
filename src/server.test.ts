import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { discoverDocsDirs } from "./server.js";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join("/tmp", "mcp-docs-discovery-"));
  tempRoots.push(root);

  const dirs = [
    "docs",
    "packages/actions/docs",
    "packages/tables/docs",
    "modules/foo/bar/docs",
  ];

  for (const dir of dirs) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }

  return root;
}

describe("discoverDocsDirs", () => {
  test("returns docs directories up to max depth", async () => {
    const root = await makeFixture();

    const depth2 = await discoverDocsDirs(root, "docs", 2);
    const depth3 = await discoverDocsDirs(root, "docs", 3);

    expect(depth2).toEqual(["docs"]);
    expect(depth3).toEqual(["docs", "packages/actions/docs", "packages/tables/docs"]);
  });

  test("returns empty for nested MCP_DOCS_DIR values", async () => {
    const root = await makeFixture();

    const discovered = await discoverDocsDirs(root, "content/docs", 5);
    expect(discovered).toEqual([]);
  });
});

