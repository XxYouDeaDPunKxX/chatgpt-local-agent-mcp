import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { callOk, callRejected, createFixture } from "./helpers/mcp-fixture.js";

test("isolated browser handlers interact with a local page and return observable results", { timeout: 45_000 }, async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url?.startsWith("/next")) {
      response.end("<!doctype html><title>Next fixture</title><h1 id=next>Next page</h1>");
      return;
    }
    response.end(`<!doctype html>
      <title>Local fixture</title>
      <label for="name">Name</label><input id="name" />
      <button id="submit" onclick="document.querySelector('#status').textContent = document.querySelector('#name').value; document.querySelector('#status').dataset.state='done'">Submit</button>
      <p id="status">Waiting</p>
      <script>console.log('fixture-ready')</script>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const f = await createFixture();
  let sessionId: string | undefined;
  try {
    const session = await callOk(f, "browser_session_create", {
      allowedHostnames: ["127.0.0.1"],
      browser: "chromium",
      headless: true,
      url: base + "/form",
    });
    sessionId = session.sessionId;
    assert.ok(sessionId);
    assert.equal(session.url, base + "/form");

    const sessions = await callOk(f, "browser_session_list");
    assert.ok(sessions.sessions.some((s: { sessionId: string }) => s.sessionId === sessionId));
    const pages = await callOk(f, "browser_page_list", { sessionId });
    assert.equal(pages.pages.length, 1);
    assert.equal(pages.pages[0].active, true);

    const snapshot = await callOk(f, "browser_snapshot", { sessionId });
    assert.match(snapshot.ariaSnapshot, /Submit/);
    const typedInput = { sessionId, selector: "#name", targetDescription: "synthetic name input", purpose: "test local input" };
    const filled = await callOk(f, "browser_fill", { ...typedInput, value: "Ada" });
    assert.equal(filled.filled, true);
    const typed = await callOk(f, "browser_type", { ...typedInput, text: " Lovelace" });
    assert.equal(typed.typed, true);
    const pressed = await callOk(f, "browser_press_key", { sessionId, key: "End", purpose: "test keyboard", targetDescription: "page" });
    assert.equal(pressed.pressed, true);
    const clicked = await callOk(f, "browser_click", {
      sessionId, selector: "#submit", targetDescription: "synthetic submit button", purpose: "show entered value",
    });
    assert.equal(clicked.clicked, true);

    const waited = await callOk(f, "browser_wait", { sessionId, selector: "#status[data-state=done]" });
    assert.equal(waited.waited, true);
    const result = await callOk(f, "browser_snapshot", { sessionId });
    assert.match(result.ariaSnapshot, /Ada Lovelace/);

    const logs = await callOk(f, "browser_console", { sessionId });
    assert.ok(logs.entries.some((entry: { text: string }) => entry.text.includes("fixture-ready")));
    const network = await callOk(f, "browser_network", { sessionId });
    assert.ok(network.entries.some((entry: { status: number; url: string }) => entry.status === 200 && entry.url === base + "/form"));

    const screenshot = await callOk(f, "browser_screenshot", { sessionId });
    assert.ok(path.resolve(screenshot.path).startsWith(path.resolve(f.root) + path.sep));
    const png = await fs.readFile(screenshot.path);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(crypto.createHash("sha256").update(png).digest("hex"), screenshot.hash);

    const navigated = await callOk(f, "browser_navigate", { sessionId, url: base + "/next" });
    assert.equal(navigated.url, base + "/next");
    const selected = await callOk(f, "browser_page_select", { sessionId, pageIndex: 0 });
    assert.equal(selected.url, base + "/next");
    await callRejected(f, "browser_navigate", { sessionId, url: "https://example.com/" }, /outside browser session allowedHostnames/i);

    const closed = await callOk(f, "browser_session_close", { sessionId });
    assert.equal(closed.closed, true);
    sessionId = undefined;
    const empty = await callOk(f, "browser_session_list");
    assert.equal(empty.sessions.length, 0);
  } finally {
    if (sessionId) {
      await f.client.callTool({ name: "browser_session_close", arguments: { sessionId } }).catch(() => undefined);
    }
    await f.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("CDP attachment requires explicit confirmation before contacting a browser profile", async () => {
  const f = await createFixture();
  try {
    await callRejected(f, "browser_cdp_connect", {
      endpointUrl: "http://127.0.0.1:1",
      isolatedBrowserBypassReason: "test guard with no browser attached",
      purpose: "verify confirmation",
    }, /confirm=true/);
  } finally {
    await f.close();
  }
});
