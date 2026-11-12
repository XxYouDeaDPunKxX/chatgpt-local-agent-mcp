import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { TOOL_DEFINITIONS, type ToolName } from "../src/tools/registry.js";
import { createFixture } from "./helpers/mcp-fixture.js";

test("all 53 MCP handlers deny a caller without the required scope", { timeout: 30_000 }, async (t) => {
  const f = await createFixture([]);
  const id = "00000000-0000-4000-8000-000000000001";
  const action = { purpose: "isolated authorization test", expectedAction: "no change" };
  const browserAction = { sessionId: id, purpose: "isolated authorization test", targetDescription: "synthetic target" };
  try {
    await fs.writeFile(path.join(f.root, "test.txt"), "synthetic\n", "utf8");
    // Each sample passes input validation; a scope regression must not be hidden by a schema error.
    const samples: Record<ToolName, Record<string, unknown>> = {
      workspace_info: {},
      stat: { path: "test.txt" },
      list_dir: { path: "." },
      tree: {},
      search: { pattern: "synthetic" },
      read_file: { path: "test.txt" },
      read_many: { paths: ["test.txt"] },
      read_file_range: { path: "test.txt", length: 1 },
      stat_many: { paths: ["test.txt"] },
      hash: { path: "test.txt" },
      write_file: { cwd: f.root, path: "test.txt", content: "new", dryRun: true },
      apply_patch: { cwd: f.root, patch: "diff --git a/test.txt b/test.txt\n--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-synthetic\n+new\n", dryRun: true },
      mkdir: { cwd: f.root, path: "new-directory" },
      copy: { cwd: f.root, from: "test.txt", to: "copy.txt", dryRun: true },
      move: { cwd: f.root, from: "test.txt", to: "move.txt", dryRun: true },
      delete: { cwd: f.root, path: "test.txt", dryRun: true },
      rollback_backup: { backupId: id, dryRun: true },
      git_status: { cwd: f.root },
      git_diff: { cwd: f.root },
      git_commit: { cwd: f.root, message: "synthetic", dryRun: true },
      start_process: { cwd: f.root, command: "echo synthetic", dryRun: true },
      tail_log: { cwd: f.root, path: "test.txt" },
      wait_for_port: { port: 1, timeoutMs: 1 },
      process_list: {},
      port_list: {},
      stop_process: { processId: id, dryRun: true },
      process_kill: { pid: 2_147_483_647, dryRun: true },
      browser_session_create: { browser: "chromium", headless: true, allowedHostnames: ["127.0.0.1"] },
      browser_navigate: { sessionId: id, url: "http://127.0.0.1/" },
      browser_snapshot: { sessionId: id },
      browser_console: { sessionId: id },
      browser_network: { sessionId: id },
      browser_wait: { sessionId: id, waitMs: 1 },
      browser_click: { ...browserAction, selector: "button" },
      browser_fill: { ...browserAction, selector: "input", value: "synthetic" },
      browser_type: { ...browserAction, selector: "input", text: "synthetic" },
      browser_press_key: { ...browserAction, key: "Enter" },
      browser_screenshot: { sessionId: id },
      browser_page_list: { sessionId: id },
      browser_page_select: { sessionId: id, pageIndex: 0 },
      browser_session_list: {},
      browser_session_close: { sessionId: id },
      browser_cdp_connect: { purpose: "isolated authorization test", isolatedBrowserBypassReason: "validate scope check", endpointUrl: "http://127.0.0.1:1" },
      window_list: {},
      screen_screenshot: { mode: "region", x: 0, y: 0, width: 1, height: 1 },
      screen_ocr: { screenshotId: id },
      desktop_mouse_position: {},
      desktop_mouse_move: { ...action, x: 0, y: 0, dryRun: true },
      desktop_mouse_click: { ...action, x: 0, y: 0, dryRun: true },
      desktop_key_press: { ...action, key: "A", dryRun: true },
      desktop_hotkey: { ...action, keys: ["CTRL", "A"], dryRun: true },
      desktop_text_type: { ...action, text: "synthetic", dryRun: true },
      shell: { command: "echo synthetic", cwd: f.root, dedicatedToolBypassReason: "authorization test", purpose: "check scope" },
    };
    assert.deepEqual(Object.keys(samples).sort(), TOOL_DEFINITIONS.map((tool) => tool.name).sort());
    for (const tool of TOOL_DEFINITIONS) {
      await t.test(tool.name, async () => {
        const result = await f.client.callTool({ name: tool.name, arguments: samples[tool.name] });
        assert.equal(result.isError, true, `${tool.name} unexpectedly accepted a scope-less call`);
        assert.match(JSON.stringify(result), /Missing required scope:/, `${tool.name} did not reject at the scope gate`);
      });
    }
    assert.equal(await fs.readFile(path.join(f.root, "test.txt"), "utf8"), "synthetic\n");
  } finally {
    await f.close();
  }
});
