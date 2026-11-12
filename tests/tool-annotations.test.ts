import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type McpRuntime } from "../src/mcp.js";

test("screenshot tool metadata discloses local writes and managed PNG cleanup", async () => {
  const runtime = {
    config: {} as McpRuntime["config"],
    context: {} as McpRuntime["context"],
    journal: {} as McpRuntime["journal"],
  } satisfies McpRuntime;
  const server = createMcpServer(runtime);
  const client = new Client({ name: "tool-metadata-check", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    for (const name of ["browser_screenshot", "screen_screenshot"]) {
      const tool = tools.find((entry) => entry.name === name);
      assert.ok(tool, `Missing tool ${name}`);
      assert.equal(tool.annotations?.readOnlyHint, false, `${name} creates a PNG`);
      assert.equal(tool.annotations?.destructiveHint, true, `${name} may delete managed PNGs`);
      assert.match(tool.description ?? "", /sav(e|es|ing).*png/i);
      assert.match(tool.description ?? "", /delet(e|es|ion|ing)/i);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
