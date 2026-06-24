import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertCommandPolicyAllowed, commandLooksMutative, commandPathHints } from "../src/command-policy.js";
import { AppConfig, loadConfig } from "../src/config.js";
import { isLoopbackAddress } from "../src/dashboard/index.js";
import { TOOL_DEFINITIONS } from "../src/tools/registry.js";

function testConfig(workspaceRoot: string): AppConfig {
  return {
    allowedGithubLogins: [],
    allowedHosts: ["127.0.0.1", "localhost", "[::1]"],
    authRateLimitMax: 60,
    authRateLimitMaxBuckets: 100,
    authRateLimitWindowMs: 60_000,
    authRequired: false,
    authRequirePkce: true,
    authStoreCleanupIntervalMs: 60_000,
    authStoreMaxAuthCodes: 100,
    authStoreMaxPending: 100,
    authStoreMaxTokens: 100,
    backupDir: path.join(workspaceRoot, "data", "backups"),
    browserSessionIdleMs: 1_000,
    cloudflareTunnelEnabled: false,
    defaultCwd: workspaceRoot,
    defaultOauthScopes: ["mcp:read"],
    devIdentityLogin: "local-dev",
    enforceWorkspaceProfiles: true,
    exposeRuntimeDebug: false,
    host: "127.0.0.1",
    journalPath: path.join(workspaceRoot, "data", "journal.jsonl"),
    maxBackupBytes: 1_000,
    maxBodyBytes: 1_000,
    maxBrowserLogEntries: 10,
    maxBrowserScreenshotBytes: 1_000,
    maxBrowserScreenshotFiles: 10,
    maxBrowserSessions: 1,
    maxOutputBytes: 1_000,
    maxPolicyMode: "operate",
    maxScreenshotAreaPixels: 1_000,
    maxScreenshotBytes: 1_000,
    maxScreenshotDimension: 100,
    maxScreenshotFiles: 10,
    oauthRedirectUris: [],
    port: 8789,
    processPolicy: "workspace_guarded",
    protectedResourceMetadataUrl: "http://127.0.0.1:8789/.well-known/oauth-protected-resource",
    publicBaseUrl: "http://127.0.0.1:8789",
    resourceUri: "http://127.0.0.1:8789/mcp",
    shellPolicy: "workspace_guarded",
    shellTimeoutMs: 1_000,
    trustProxyHeaders: false,
    workspaceProfiles: [
      {
        allowedPolicyModes: ["observe", "diagnose", "edit", "operate"],
        backupPolicy: "manual",
        label: "Test workspace",
        name: "test",
        rootPath: workspaceRoot,
        secretDenyGlobs: ["**/.env", "**/*secret*"],
      },
    ],
  };
}

test("workspace_guarded rejects disabled shell policy", () => {
  const cwd = path.join(os.tmpdir(), "gpt-fs-policy-workspace");
  assert.throws(
    () =>
      assertCommandPolicyAllowed({
        command: "npm test",
        config: testConfig(cwd),
        cwd,
        policy: "disabled",
        policyMode: "operate",
        tool: "shell",
      }),
    /disabled by command policy/,
  );
});

test("workspace_guarded shell requires expected paths for recognized mutations", () => {
  const cwd = path.join(os.tmpdir(), "gpt-fs-policy-workspace");
  assert.equal(commandLooksMutative("Set-Content file.txt value"), true);
  assert.throws(
    () =>
      assertCommandPolicyAllowed({
        command: "Set-Content file.txt value",
        config: testConfig(cwd),
        cwd,
        policy: "workspace_guarded",
        policyMode: "operate",
        tool: "shell",
      }),
    /expectedTouchedPaths/,
  );
});

test("workspace_guarded allows declared in-workspace shell mutations", () => {
  const cwd = path.join(os.tmpdir(), "gpt-fs-policy-workspace");
  assert.doesNotThrow(() =>
    assertCommandPolicyAllowed({
      command: "Set-Content .\\out.txt value",
      config: testConfig(cwd),
      cwd,
      expectedTouchedPaths: ["out.txt"],
      policy: "workspace_guarded",
      policyMode: "operate",
      tool: "shell",
    }),
  );
});

test("workspace_guarded rejects explicit outside paths", () => {
  const cwd = path.join(os.tmpdir(), "gpt-fs-policy-workspace");
  const outside = path.join(os.tmpdir(), "outside.txt");
  assert.throws(
    () =>
      assertCommandPolicyAllowed({
        command: `Get-Content "${outside}"`,
        config: testConfig(cwd),
        cwd,
        policy: "workspace_guarded",
        policyMode: "operate",
        tool: "start_process",
      }),
    /outside configured workspace profiles/,
  );
});

test("full command policy allows explicit outside paths", () => {
  const cwd = path.join(os.tmpdir(), "gpt-fs-policy-workspace");
  const outside = path.join(os.tmpdir(), "outside.txt");
  assert.doesNotThrow(() =>
    assertCommandPolicyAllowed({
      command: `Get-Content "${outside}"`,
      config: testConfig(cwd),
      cwd,
      policy: "full",
      policyMode: "operate",
      tool: "start_process",
    }),
  );
});

test("workspace_guarded rejects sensitive in-workspace paths", () => {
  const cwd = path.join(os.tmpdir(), "gpt-fs-policy-workspace");
  assert.throws(
    () =>
      assertCommandPolicyAllowed({
        command: "Get-Content .env",
        config: testConfig(cwd),
        cwd,
        policy: "workspace_guarded",
        policyMode: "operate",
        tool: "start_process",
      }),
    /sensitive path guards/,
  );
});

test("loadConfig defaults workspace profiles to filesystem roots, not default cwd", () => {
  const keys = [
    "AUTH_REQUIRED",
    "CLOUDFLARE_TUNNEL_ENABLED",
    "GPT_FS_MCP_DEFAULT_CWD",
    "GPT_FS_MCP_WORKSPACE_PROFILES_JSON",
    "NODE_ENV",
    "PUBLIC_BASE_URL",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const customDefaultCwd = path.join(os.tmpdir(), "gpt-fs-default-cwd-only");

  try {
    process.env.AUTH_REQUIRED = "false";
    process.env.CLOUDFLARE_TUNNEL_ENABLED = "false";
    process.env.GPT_FS_MCP_DEFAULT_CWD = customDefaultCwd;
    delete process.env.GPT_FS_MCP_WORKSPACE_PROFILES_JSON;
    process.env.NODE_ENV = "development";
    process.env.PUBLIC_BASE_URL = "http://127.0.0.1:8789";

    const config = loadConfig();
    const currentRoot = path.resolve(path.parse(process.cwd()).root);

    assert.equal(config.defaultCwd, customDefaultCwd);
    assert.ok(config.workspaceProfiles.length >= 1);
    assert.ok(config.workspaceProfiles.some((profile) => path.resolve(profile.rootPath) === currentRoot));
    assert.ok(!config.workspaceProfiles.some((profile) => path.resolve(profile.rootPath) === path.resolve(customDefaultCwd)));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("tool registry exposes shell as the final fallback tool", () => {
  assert.equal(TOOL_DEFINITIONS.at(-1)?.name, "shell");
  assert.ok(TOOL_DEFINITIONS.findIndex((tool) => tool.name === "write_file") < TOOL_DEFINITIONS.findIndex((tool) => tool.name === "shell"));
});

test("commandPathHints extracts quoted and expected path tokens", () => {
  const cwd = path.join(os.tmpdir(), "gpt-fs-policy-workspace");
  const hints = commandPathHints(cwd, 'Get-Content ".\\src\\index.ts"', ["dist\\index.js"]);
  assert.deepEqual(
    hints.map((hint) => path.relative(cwd, hint.absolutePath)).sort(),
    ["dist\\index.js", "src\\index.ts"].sort(),
  );
});

test("dashboard loopback helper accepts only loopback peers", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("203.0.113.10"), false);
  assert.equal(isLoopbackAddress(undefined), false);
});
