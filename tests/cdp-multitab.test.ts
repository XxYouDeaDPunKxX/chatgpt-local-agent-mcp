import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { chromium, type BrowserContext } from "playwright";
import { callOk, createFixture } from "./helpers/mcp-fixture.js";

test("CDP preserves unrelated tabs through rejected selection and agent actions", { timeout: 30_000 }, async () => {
  const f = await createFixture();
  const pageServer = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end('<!doctype html><title>Allowed fixture</title><button id="do-it" onclick="document.querySelector(\'#result\').textContent=\'clicked\'">Click</button><span id="result">pending</span><button id="open-popup" onclick="window.open(location.href.replace(\'127.0.0.1\',\'localhost\'),\'_blank\')">Open popup</button>');
  });
  let sessionId: string | undefined;
  let hostContext: BrowserContext | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      pageServer.once("error", reject);
      pageServer.listen(0, "127.0.0.1", resolve);
    });
    const port = (pageServer.address() as AddressInfo).port;
    const profilePath = path.join(f.root, "temporary-chromium-profile");
    await fs.mkdir(profilePath);
    const allowedUrl = `http://127.0.0.1:${port}/`;
    hostContext = await chromium.launchPersistentContext(profilePath, {
      headless: true,
      args: ["--remote-debugging-port=0"],
    });
    const allowedPage = hostContext.pages()[0] ?? await hostContext.newPage();
    await allowedPage.goto(allowedUrl);
    const unrelatedUrl = "data:text/html,<title>UNRELATED TAB</title><h1>Keep me</h1>";
    const unrelatedPage = await hostContext.newPage();
    await unrelatedPage.goto(unrelatedUrl);

    let cdpPort = 0;
    for (let i = 0; i < 100; i += 1) {
      const activePort = await fs.readFile(path.join(profilePath, "DevToolsActivePort"), "utf8").catch(() => "");
      cdpPort = Number(activePort.split(/\r?\n/)[0]);
      if (cdpPort > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(cdpPort > 0, "Temporary Chromium did not expose a loopback CDP port");
    const endpoint = `http://127.0.0.1:${cdpPort}`;
    const targetsBefore = await (await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(3_000) })).json() as Array<{ id: string; url: string }>;
    const unrelatedTarget = targetsBefore.find((target) => target.url === unrelatedUrl);
    assert.ok(unrelatedTarget?.id, "Unrelated synthetic tab must exist before attachment");

    // CDP page ordering is not stable across Chromium launches. Probe only the
    // two fixture tabs; the out-of-scope tab must be rejected during selection.
    let attached: Record<string, any> | undefined;
    for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
      const result = await f.client.callTool({ name: "browser_cdp_connect", arguments: {
        endpointUrl: endpoint,
        allowedHostnames: ["127.0.0.1"],
        pageIndex,
        purpose: "isolated CDP ownership regression",
        isolatedBrowserBypassReason: "exercise pre-existing unrelated tabs",
        confirm: true,
        timeoutMs: 5_000,
      } });
      if (!result.isError) {
        attached = result.structuredContent as Record<string, any>;
        break;
      }
      assert.match(JSON.stringify(result), /Selected CDP page is outside browser session allowedHostnames/);
    }
    assert.ok(attached, "An allowed fixture tab must be available for CDP attachment");
    sessionId = attached.sessionId;
    assert.equal(attached.source, "cdp");
    assert.equal(attached.url, allowedUrl);
    assert.ok(attached.pages.some((page: { outOfScope: boolean; title: string }) => page.outOfScope && page.title === "UNRELATED TAB"));

    const listed = await callOk(f, "browser_page_list", { sessionId });
    const unrelatedPageInfo = listed.pages.find((page: { outOfScope: boolean; title: string }) =>
      page.outOfScope && page.title === "UNRELATED TAB");
    assert.ok(unrelatedPageInfo);
    const rejectedSelection = await f.client.callTool({ name: "browser_page_select", arguments: {
      sessionId,
      pageIndex: unrelatedPageInfo.pageIndex,
    } });
    assert.equal(rejectedSelection.isError, true, "Selecting an out-of-scope CDP tab must be denied");
    const afterSelection = await (await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(3_000) })).json() as Array<{ id: string }>;
    assert.ok(afterSelection.some((target) => target.id === unrelatedTarget.id),
      "A denied page selection must not close a pre-existing unrelated tab");

    const clicked = await callOk(f, "browser_click", {
      sessionId,
      selector: "#do-it",
      targetDescription: "local fixture button",
      purpose: "set synthetic local DOM text",
      confirm: true,
    });
    assert.equal(clicked.clicked, true);
    const snapshot = await callOk(f, "browser_snapshot", { sessionId });
    assert.match(snapshot.ariaSnapshot, /clicked/);
    const targetsAfter = await (await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(3_000) })).json() as Array<{ id: string; title: string }>;
    assert.ok(targetsAfter.some((target) => target.id === unrelatedTarget.id && target.title === "UNRELATED TAB"),
      "The agent must not close a pre-existing unrelated CDP tab");
    assert.deepEqual(clicked.closedOutOfScopePages, []);

    const opened = await callOk(f, "browser_click", {
      sessionId,
      selector: "#open-popup",
      targetDescription: "synthetic out-of-scope popup button",
      purpose: "verify only agent-created out-of-scope tabs are closed",
      confirm: true,
    });
    assert.ok(opened.closedOutOfScopePages.some((page: { url: string }) => page.url.includes("localhost")),
      "Agent-created out-of-scope popup should be closed");
    const targetsAfterPopup = await (await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(3_000) })).json() as Array<{ id: string }>;
    assert.ok(targetsAfterPopup.some((target) => target.id === unrelatedTarget.id),
      "Closing an agent popup must still preserve the unrelated pre-existing tab");
  } finally {
    if (sessionId) await f.client.callTool({ name: "browser_session_close", arguments: { sessionId } }).catch(() => undefined);
    if (hostContext) await hostContext.close().catch(() => undefined);
    if (pageServer.listening) {
      pageServer.closeAllConnections();
      await new Promise<void>((resolve) => pageServer.close(() => resolve()));
    }
    await f.close();
  }
});
