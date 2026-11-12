import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Journal } from "../../src/journal.js";
import { createMcpServer, type McpRuntime } from "../../src/mcp.js";
import { ALL_SCOPES } from "../../src/scopes.js";

export type IsolatedFixture = {
  client: Client;
  close: () => Promise<void>;
  root: string;
};

/** An actual MCP server and handler set, confined to a disposable workspace. */
export async function createFixture(
  scopes: string[] = [...ALL_SCOPES],
  overrides: Partial<McpRuntime["config"]> = {},
): Promise<IsolatedFixture> {
  // Windows runners may expose TEMP through a directory alias. Match the
  // physical path checked by assertPathTargetAllowed for workspace profiles.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "local-agent-tool-test-")));
  const journalPath = path.join(root, ".runtime", "journal.jsonl");
  const config = {
    authRequired: false,
    backupDir: path.join(root, ".runtime", "backups"),
    browserSessionIdleMs: 60_000,
    defaultCwd: root,
    enforceWorkspaceProfiles: true,
    exposeRuntimeDebug: false,
    journalPath,
    maxBackupBytes: 1_000_000,
    maxBrowserLogEntries: 100,
    maxBrowserScreenshotBytes: 1_000_000,
    maxBrowserScreenshotFiles: 5,
    maxBrowserSessions: 2,
    maxOutputBytes: 1_000_000,
    maxPolicyMode: "destructive",
    processPolicy: "disabled",
    shellPolicy: "disabled",
    shellTimeoutMs: 8_000,
    workspaceProfiles: [{
      allowedPolicyModes: ["observe", "diagnose", "edit", "operate", "destructive"],
      backupPolicy: "snapshot",
      label: "Disposable test workspace",
      name: "test",
      rootPath: root,
      secretDenyGlobs: ["**/.env"],
    }],
    ...overrides,
  } as McpRuntime["config"];
  const server = createMcpServer({
    config,
    context: {
      identity: { provider: "local-dev", subject: "isolated-test" },
      requestId: crypto.randomUUID(),
      scopes,
    },
    journal: new Journal(journalPath),
  });
  const client = new Client({ name: "isolated-mcp-tool-tests", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  } catch (error) {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    client,
    root,
    close: async () => {
      await client.close();
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export async function callOk(fixture: IsolatedFixture, name: string, args: Record<string, unknown> = {}) {
  const result = await fixture.client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
  assert.ok(result.structuredContent, `${name}: structured response missing`);
  return result.structuredContent as Record<string, any>;
}

export async function callRejected(
  fixture: IsolatedFixture,
  name: string,
  args: Record<string, unknown>,
  message: RegExp,
) {
  const result = await fixture.client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
  assert.match(JSON.stringify(result), message, `${name}: wrong rejection`);
}
