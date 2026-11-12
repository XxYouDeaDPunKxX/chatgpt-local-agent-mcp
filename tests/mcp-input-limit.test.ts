import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, MAX_TOOL_INPUT_ELEMENTS, type McpRuntime } from "../src/mcp.js";
import { TOOL_DEFINITIONS } from "../src/tools/registry.js";

test("MCP rejects oversized tool inputs before invoking filesystem handlers", async () => {
  const runtime = {
    config: {} as McpRuntime["config"],
    context: {} as McpRuntime["context"],
    journal: {} as McpRuntime["journal"],
  } satisfies McpRuntime;
  const server = createMcpServer(runtime);
  const client = new Client({ name: "local-agent-input-limit-test", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), TOOL_DEFINITIONS.map((tool) => tool.name).sort());

    const result = await client.callTool({
      name: "stat_many",
      arguments: { paths: Array(MAX_TOOL_INPUT_ELEMENTS + 1).fill(".") },
    });

    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /limit|elements|exceed/i);
  } finally {
    await client.close();
    await server.close();
  }
});
