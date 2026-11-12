import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { callOk, callRejected, createFixture } from "./helpers/mcp-fixture.js";

test("git tools inspect and commit only an isolated temporary repository", { timeout: 20_000 }, async () => {
  const f = await createFixture();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: f.root, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.name", "Synthetic Test");
    git("config", "user.email", "test@invalid.example");
    await fs.writeFile(path.join(f.root, "note.txt"), "first\n", "utf8");
    const status = await callOk(f, "git_status", { cwd: f.root });
    assert.match(status.stdout, /\?\? note\.txt/);

    git("add", "--", "note.txt");
    await fs.writeFile(path.join(f.root, "note.txt"), "second\n", "utf8");
    const diff = await callOk(f, "git_diff", { cwd: f.root });
    assert.match(diff.stdout, /-first/);
    assert.match(diff.stdout, /\+second/);
    const staged = await callOk(f, "git_diff", { cwd: f.root, staged: true });
    assert.match(staged.stdout, /\+first/);

    const preview = await callOk(f, "git_commit", { cwd: f.root, message: "fixture commit" });
    assert.equal(preview.dryRun, true);
    assert.equal(git("rev-list", "--all", "--count").trim(), "0");
    await callRejected(f, "git_commit", { cwd: f.root, message: "fixture commit", dryRun: false }, /confirm=true/);
    const committed = await callOk(f, "git_commit", { cwd: f.root, message: "fixture commit", dryRun: false, confirm: true });
    assert.equal(committed.code, 0);
    assert.equal(git("log", "-1", "--format=%s").trim(), "fixture commit");
    assert.equal(await fs.readFile(path.join(f.root, "note.txt"), "utf8"), "second\n");
  } finally {
    await f.close();
  }
});

test("process discovery and wait_for_port observe a synthetic loopback listener", { timeout: 20_000 }, async (t) => {
  const f = await createFixture();
  const listener = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const port = (listener.address() as AddressInfo).port;
    const waited = await callOk(f, "wait_for_port", { port, timeoutMs: 2_000, intervalMs: 50 });
    assert.equal(waited.reachable, true);
    const ports = await callOk(f, "port_list", { protocol: "tcp" });
    assert.ok(ports.ports.some((item: { localPort: number }) => item.localPort === port));
    const processResult = await f.client.callTool({ name: "process_list", arguments: { maxProcesses: 2_000 } });
    if (processResult.isError && /accesso negato|access is denied/i.test(JSON.stringify(processResult))) {
      t.skip("Windows denied Win32_Process enumeration in this sandbox");
      return;
    }
    assert.notEqual(processResult.isError, true, `process_list: ${JSON.stringify(processResult)}`);
    const processes = processResult.structuredContent as { processes: Array<{ pid: number }> };
    assert.ok(Array.isArray(processes.processes));
    assert.ok(processes.processes.some((item) => item.pid === process.pid));
    await callRejected(f, "wait_for_port", { host: "example.com", port: 80, timeoutMs: 1 }, /loopback hosts/);
    await callRejected(f, "process_kill", { pid: process.pid }, /Refusing to kill the MCP server process/);
  } finally {
    if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
    await f.close();
  }
});

test("shell executes one bounded synthetic command when explicitly permitted", { timeout: 15_000 }, async () => {
  const f = await createFixture(undefined, { shellPolicy: "full" });
  try {
    const result = await callOk(f, "shell", {
      command: "node -p 6*7",
      cwd: f.root,
      dedicatedToolBypassReason: "isolated shell transport regression",
      purpose: "assert a bounded command result",
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "42");
    assert.equal(result.timedOut, false);
  } finally {
    await f.close();
  }
});

test("managed process dry-run does not spawn and a short-lived fixture records its exit", { timeout: 25_000 }, async () => {
  const f = await createFixture(undefined, { processPolicy: "full" });
  let pid: number | undefined;
  try {
    const command = "node -e \"console.log('fixture-ready')\"";
    const planned = await callOk(f, "start_process", { cwd: f.root, command });
    assert.equal(planned.dryRun, true);
    assert.equal(planned.processId, undefined);
    const started = await callOk(f, "start_process", { cwd: f.root, command, confirm: true, dryRun: false });
    assert.ok(started.processId);
    pid = started.pid;
    const dryStop = await callOk(f, "stop_process", { processId: started.processId });
    assert.equal(dryStop.stopped, false);
    let logContent = "";
    for (let i = 0; i < 30; i += 1) {
      const tail = await callOk(f, "tail_log", { processId: started.processId, maxBytes: 4096 });
      logContent = tail.content;
      if (logContent.includes("fixture-ready")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(logContent, /fixture-ready/);
    const metadataPath = path.join(f.root, ".runtime", "processes", started.processId, "metadata.json");
    let status = "running";
    for (let i = 0; i < 30; i += 1) {
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as { status: string };
      status = metadata.status;
      if (status === "exited") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status, "exited");
    const stopped = await callOk(f, "stop_process", { processId: started.processId, confirm: true, dryRun: false });
    assert.equal(stopped.exited, true);
    assert.equal(stopped.stopped, false);
    pid = undefined;
  } finally {
    if (pid && process.platform === "win32") {
      try { execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already stopped */ }
    } else if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
    }
    await f.close();
  }
});

test("stop_process terminates a live managed synthetic process", { timeout: 15_000 }, async (t) => {
  const f = await createFixture(undefined, { processPolicy: "full" });
  try {
    // An automatic exit bounds cleanup even if Windows denies taskkill in this sandbox.
    const command = 'node -e "console.log(\'fixture-live\'); setTimeout(() => process.exit(0), 4000)"';
    const started = await callOk(f, "start_process", { cwd: f.root, command, confirm: true, dryRun: false });
    assert.ok(started.processId);
    assert.ok(started.pid > 0);

    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const tail = await callOk(f, "tail_log", { processId: started.processId, maxBytes: 4096 });
      if (tail.content.includes("fixture-live")) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "The managed child should reach its ready state");

    const preview = await callOk(f, "stop_process", { processId: started.processId });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.stopped, false);
    assert.equal(preview.exited, false);

    const stopResult = await f.client.callTool({
      name: "stop_process",
      arguments: { processId: started.processId, dryRun: false, confirm: true },
    });
    const stopped = stopResult.structuredContent as Record<string, unknown>;
    const deniedBySandbox = stopResult.isError === true && /access is denied|accesso negato/i.test(String(stopped?.stderr));
    if (!deniedBySandbox) {
      assert.notEqual(stopResult.isError, true, `stop_process: ${JSON.stringify(stopResult)}`);
      assert.equal(stopped.dryRun, false);
      assert.equal(stopped.stopped, true);
      assert.equal(stopped.code, 0);
    }

    const metadataPath = path.join(f.root, ".runtime", "processes", started.processId, "metadata.json");
    let exited = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as { status: string };
      if (metadata.status === "exited") {
        exited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(exited, true, "The managed process metadata should record exit");
    if (deniedBySandbox) t.skip("Windows denied taskkill for the synthetic child; live stop remains unverified here");
  } finally {
    await f.close();
  }
});

test("process_kill confirms the exact synthetic child identity before termination", { timeout: 20_000 }, async (t) => {
  const f = await createFixture();
  const marker = `local-agent-kill-fixture-${crypto.randomUUID()}`;
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),4000)", marker], {
    cwd: f.root,
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    assert.ok(child.pid);
    const args = {
      pid: child.pid,
      expectedName: path.basename(process.execPath),
      expectedCommandSubstring: marker,
      tree: true,
    };
    const discovery = await f.client.callTool({ name: "process_list", arguments: { maxProcesses: 2_000 } });
    if (discovery.isError && /accesso negato|access is denied/i.test(JSON.stringify(discovery))) {
      t.skip("Windows denied Win32_Process enumeration required by process_kill");
      return;
    }
    assert.notEqual(discovery.isError, true, `process_list: ${JSON.stringify(discovery)}`);
    const previewResult = await f.client.callTool({ name: "process_kill", arguments: args });
    if (previewResult.isError && /accesso negato|access is denied/i.test(JSON.stringify(previewResult))) {
      t.skip("Windows denied Win32_Process enumeration needed to verify the synthetic child identity");
      return;
    }
    assert.notEqual(previewResult.isError, true, `process_kill: ${JSON.stringify(previewResult)}`);
    const preview = previewResult.structuredContent as Record<string, any>;
    assert.equal(preview.dryRun, true);
    assert.equal(preview.killed, false);
    assert.equal(child.exitCode, null);
    await callRejected(f, "process_kill", { ...args, expectedCommandSubstring: "wrong-fixture-marker" }, /command line mismatch/i);
    const killed = await callOk(f, "process_kill", { ...args, confirm: true, dryRun: false });
    assert.equal(killed.killed, true);
    assert.equal(killed.code, 0);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Child did not exit after kill")), 3_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 6_000);
        child.once("exit", () => { clearTimeout(timeout); resolve(); });
      });
    }
    await f.close();
  }
});
