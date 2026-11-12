import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type McpRuntime } from "../src/mcp.js";

test("tail_log reports metadata effects and preserves stale process recovery", { timeout: 20_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-agent-tail-log-test-"));
  const id = crypto.randomUUID();
  const directory = path.join(root, "processes", id);
  const metadataPath = path.join(directory, "metadata.json");
  const stdoutPath = path.join(directory, "stdout.log");
  const stderrPath = path.join(directory, "stderr.log");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(stdoutPath, "hello from test\n", "utf8");
  await fs.writeFile(stderrPath, "", "utf8");
  await fs.writeFile(metadataPath, JSON.stringify({
    command: "fake test process",
    cwd: root,
    id,
    maxLogBytes: 1_000_000,
    pid: 2_147_483_647,
    startedAt: "2026-11-01T00:00:00.000Z",
    status: "running",
    stderrBytes: 0,
    stderrPath,
    stderrTruncated: false,
    stdoutBytes: 16,
    stdoutPath,
    stdoutTruncated: false,
  }), "utf8");

  const events: unknown[] = [];
  const runtime = {
    config: {
      journalPath: path.join(root, "journal.jsonl"),
      maxOutputBytes: 100_000,
      shellTimeoutMs: 10_000,
      maxPolicyMode: "observe",
      defaultCwd: root,
    } as McpRuntime["config"],
    context: {
      requestId: crypto.randomUUID(),
      identity: { provider: "local-dev", subject: "test" },
      scopes: ["mcp:process"],
    } as McpRuntime["context"],
    journal: { append: async (entry: unknown) => { events.push(entry); } } as McpRuntime["journal"],
  } satisfies McpRuntime;

  const server = createMcpServer(runtime);
  const client = new Client({ name: "isolated-tail-log-test", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === "tail_log");
    assert.ok(tool);
    assert.equal(tool.annotations?.readOnlyHint, false, "hydration may persist metadata");
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.match(tool.description ?? "", /metadata/i);

    const result = await client.callTool({ name: "tail_log", arguments: { processId: id } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(JSON.stringify(result), /hello from test/);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as { status: string; exitCode: number | null };
    assert.equal(metadata.status, "exited");
    assert.equal(metadata.exitCode, null);
    assert.equal(events.length, 1);
  } finally {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
