import assert from "node:assert/strict";
import test from "node:test";
import { callOk, callRejected, createFixture } from "../helpers/mcp-fixture.js";

test("Windows desktop actions default to dry-run without changing input state", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") {
    t.skip("Requires an interactive Windows desktop");
    return;
  }
  const f = await createFixture();
  const action = { purpose: "manual desktop dry-run test", expectedAction: "no actual UI action" };
  try {
    const state = await callOk(f, "desktop_mouse_position");
    const point = { x: state.mousePosition.x, y: state.mousePosition.y };
    assert.equal(typeof point.x, "number");
    assert.equal(typeof point.y, "number");

    const moved = await callOk(f, "desktop_mouse_move", { ...point, ...action });
    assert.equal(moved.dryRun, true);
    assert.equal(moved.moved, false);
    assert.equal(moved.wouldExecute, true);

    const clicked = await callOk(f, "desktop_mouse_click", { ...point, ...action });
    assert.equal(clicked.dryRun, true);
    assert.equal(clicked.clicked, false);

    const pressed = await callOk(f, "desktop_key_press", { ...action, key: "A" });
    assert.equal(pressed.dryRun, true);
    assert.equal(pressed.pressed, false);
    const hotkey = await callOk(f, "desktop_hotkey", { ...action, keys: ["CTRL", "A"] });
    assert.equal(hotkey.dryRun, true);
    assert.equal(hotkey.pressed, false);
    const typed = await callOk(f, "desktop_text_type", { ...action, text: "synthetic" });
    assert.equal(typed.dryRun, true);
    assert.equal(typed.typed, false);
    assert.equal(typed.length, 9);

    const windows = await callOk(f, "window_list", { maxWindows: 10 });
    assert.equal(windows.raw, false);
    assert.equal(windows.redacted, true);
    assert.ok(windows.windows.length <= 10);
    await callRejected(f, "window_list", { raw: true }, /confirm=true/);
  } finally {
    await f.close();
  }
});
