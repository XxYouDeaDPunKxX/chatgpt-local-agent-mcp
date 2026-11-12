import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { callOk, callRejected, createFixture } from "./helpers/mcp-fixture.js";

test("screen_ocr reads a synthetic screenshot and reports Tesseract availability", { timeout: 20_000 }, async () => {
  const f = await createFixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const screenshotId = crypto.randomUUID();
    const screenshotDir = path.join(f.root, ".runtime", "screenshots");
    await fs.mkdir(screenshotDir, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 800, height: 170 }, deviceScaleFactor: 1 });
    await page.setContent('<html><body style="margin:0;background:white;color:black;font:48px Arial;padding:30px">LOCAL AGENT OCR 42</body></html>');
    await page.screenshot({ path: path.join(screenshotDir, `${screenshotId}.png`) });

    const result = await callOk(f, "screen_ocr", { screenshotId, language: "eng", psm: 6 });
    assert.equal(result.path, path.join(screenshotDir, `${screenshotId}.png`));
    assert.equal(result.sourceTrust, "screen_observed_content");
    assert.equal(result.redacted, true);
    if (result.available) {
      assert.match(result.text, /LOCAL\s+AGENT\s+OCR\s+42/i);
    } else {
      assert.equal(result.text, "");
      assert.ok(result.error, "OCR unavailability must explain the reason");
    }

    await callRejected(f, "screen_ocr", { screenshotId: crypto.randomUUID() }, /ENOENT|no such file/i);
  } finally {
    await browser.close();
    await f.close();
  }
});
