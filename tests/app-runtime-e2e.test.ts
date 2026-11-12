import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type Fixture = { base: string; root: string; child: ChildProcess; logs: () => string; close: () => Promise<void> };

async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function fixture(auth: boolean): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-checkout-e2e-"));
  const port = await freeLoopbackPort();
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    SYSTEMROOT: process.env.SYSTEMROOT,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NODE_ENV: "development",
    AUTH_REQUIRED: String(auth),
    AUTH_REQUIRE_PKCE: "true",
    GITHUB_CLIENT_ID: "synthetic-github-client",
    GITHUB_CLIENT_SECRET: "synthetic-github-secret",
    OAUTH_CLIENT_ID: "synthetic-mcp-client",
    OAUTH_CLIENT_SECRET: "synthetic-mcp-secret",
    OAUTH_REDIRECT_URIS: "http://127.0.0.1:33333/callback",
    ALLOWED_GITHUB_LOGINS: "synthetic-user",
    GPT_FS_MCP_HOST: "127.0.0.1",
    GPT_FS_MCP_PORT: String(port),
    PUBLIC_BASE_URL: base,
    CLOUDFLARE_TUNNEL_ENABLED: "false",
    TRUST_PROXY_HEADERS: "false",
    GPT_FS_MCP_PROCESS_POLICY: "disabled",
    GPT_FS_MCP_SHELL_POLICY: "disabled",
    GPT_FS_MCP_MAX_POLICY_MODE: "operate",
    GPT_FS_MCP_DEFAULT_CWD: root,
    GPT_FS_MCP_JOURNAL_PATH: path.join(root, "journal.jsonl"),
    GPT_FS_MCP_BACKUP_DIR: path.join(root, "backups"),
    GPT_FS_MCP_WORKSPACE_PROFILES_JSON: JSON.stringify([{
      name: "e2e-temp", label: "E2E temp", rootPath: root,
      allowedPolicyModes: ["observe", "diagnose", "operate"], backupPolicy: "none", secretDenyGlobs: [],
    }]),
  };
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-6000); });
  child.stderr?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-6000); });
  const close = async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    await fs.rm(root, { recursive: true, force: true });
  };
  try {
    let ready = false;
    for (let n = 0; n < 80; n += 1) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(base + "/healthz", { signal: AbortSignal.timeout(400) });
        if (response.ok) { ready = true; break; }
      } catch { /* not listening yet */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("Isolated server did not start: " + output);
    return { base, root, child, logs: () => output, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test("real Express server: OAuth discovery and authentication guards with synthetic credentials", { timeout: 30_000 }, async () => {
  const f = await fixture(true);
  try {
    const health = await (await fetch(f.base + "/healthz")).json() as { ok: boolean; authRequired: boolean };
    assert.equal(health.ok, true);
    assert.equal(health.authRequired, true);
    const metadata = await (await fetch(f.base + "/.well-known/oauth-authorization-server")).json() as { issuer: string; token_endpoint: string };
    assert.equal(metadata.issuer, f.base);
    assert.equal(metadata.token_endpoint, f.base + "/token");
    const missing = await fetch(f.base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get("www-authenticate") ?? "", /Bearer/i);
    const badToken = await fetch(f.base + "/mcp", { method: "POST", headers: { authorization: "Bearer fake-token", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(badToken.status, 401);
    const authorize = new URL(f.base + "/authorize");
    authorize.search = new URLSearchParams({
      response_type: "code", client_id: "synthetic-mcp-client",
      redirect_uri: "http://127.0.0.1:33333/callback", state: "safe-state",
      resource: f.base + "/mcp",
      code_challenge_method: "S256", code_challenge: crypto.createHash("sha256").update("synthetic-verifier-12345").digest("base64url"),
    }).toString();
    const redirected = await fetch(authorize, { redirect: "manual" });
    assert.equal(redirected.status, 302);
    const destination = new URL(redirected.headers.get("location")!);
    assert.equal(destination.hostname, "github.com");
    assert.equal(destination.pathname, "/login/oauth/authorize");
    // Redirect is inspected, never followed. No request is sent to GitHub.
    const badClient = await fetch(f.base + "/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code&client_id=incorrect&client_secret=incorrect" });
    assert.equal(badClient.status, 401);
    const badGrant = await fetch(f.base + "/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: "synthetic-mcp-client", client_secret: "synthetic-mcp-secret", code: "invalid", redirect_uri: "http://127.0.0.1:33333/callback" }) });
    assert.equal(badGrant.status, 400);
    assert.equal((await badGrant.json() as { error: string }).error, "invalid_grant");
  } finally {
    await f.close();
  }
});

test("real Express server: dev MCP HTTP tools, body guard, browser screenshot and Windows region capture", { timeout: 60_000 }, async (t) => {
  const f = await fixture(false);
  const client = new Client({ name: "checkout-runtime-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(f.base + "/mcp"));
  try {
    const forbiddenMethod = await fetch(f.base + "/mcp", { method: "GET" });
    assert.equal(forbiddenMethod.status, 405);
    const oversized = await fetch(f.base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filler: "x".repeat(350_000) }) });
    assert.equal(oversized.status, 413);
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 53);
    const info = await client.callTool({ name: "workspace_info", arguments: {} });
    assert.notEqual(info.isError, true, JSON.stringify(info));
    const infoContent = info.structuredContent as { authRequired: boolean; defaultCwd: string };
    assert.equal(infoContent.authRequired, false);
    assert.equal(path.resolve(infoContent.defaultCwd), path.resolve(f.root));

    await t.test("isolated Playwright Chromium browser and PNG screenshot", async () => {
      let sessionId: string | undefined;
      try {
        const created = await client.callTool({ name: "browser_session_create", arguments: {
          allowedHostnames: ["127.0.0.1"], browser: "chromium", headless: true,
          url: f.base + "/healthz", viewportWidth: 500, viewportHeight: 300,
        }});
        assert.notEqual(created.isError, true, JSON.stringify(created));
        sessionId = (created.structuredContent as { sessionId: string }).sessionId;
        assert.ok(sessionId);
        const snapshot = await client.callTool({ name: "browser_snapshot", arguments: { sessionId } });
        assert.notEqual(snapshot.isError, true, JSON.stringify(snapshot));
        const capture = await client.callTool({ name: "browser_screenshot", arguments: { sessionId } });
        assert.notEqual(capture.isError, true, JSON.stringify(capture));
        const data = capture.structuredContent as { path: string; hash: string; size: number };
        assert.ok(path.resolve(data.path).startsWith(path.resolve(f.root) + path.sep));
        const bytes = await fs.readFile(data.path);
        assert.ok(bytes.byteLength > 50);
        assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), data.hash);
      } finally {
        if (sessionId) {
          const closed = await client.callTool({ name: "browser_session_close", arguments: { sessionId } });
          assert.notEqual(closed.isError, true, JSON.stringify(closed));
        }
      }
    });

    await t.test("2x2 desktop region screenshot stays in isolated fixture", async () => {
      const captured = await client.callTool({ name: "screen_screenshot", arguments: {
        mode: "region", x: 0, y: 0, width: 2, height: 2, includeImageBase64: false,
      }});
      assert.notEqual(captured.isError, true, JSON.stringify(captured));
      const data = captured.structuredContent as { path: string; size: number; hash: string; bounds: { width: number; height: number } };
      assert.ok(path.resolve(data.path).startsWith(path.resolve(f.root) + path.sep));
      assert.equal(data.bounds.width, 2);
      assert.equal(data.bounds.height, 2);
      const bytes = await fs.readFile(data.path);
      assert.ok(bytes.byteLength > 40);
      assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), data.hash);
    });
  } finally {
    await client.close().catch(() => undefined);
    await f.close();
  }
});
