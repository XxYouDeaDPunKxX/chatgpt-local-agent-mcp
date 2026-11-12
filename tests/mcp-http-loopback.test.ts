import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, type McpRuntime } from "../src/mcp.js";
import { TOOL_DEFINITIONS } from "../src/tools/registry.js";

test("MCP Streamable HTTP lists the tools on isolated loopback", { timeout: 15_000 }, async () => {
  const app = express();
  app.post("/mcp", express.json({ limit: "300kb" }), async (req, res) => {
    const server = createMcpServer({
      config: {} as McpRuntime["config"],
      context: {} as McpRuntime["context"],
      journal: {} as McpRuntime["journal"],
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: String(error) });
    }
  });

  const listener = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address() as AddressInfo;
  const client = new Client({ name: "isolated-http-check", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), TOOL_DEFINITIONS.map((tool) => tool.name).sort());
  } finally {
    await client.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});
