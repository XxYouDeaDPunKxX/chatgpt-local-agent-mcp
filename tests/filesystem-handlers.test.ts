import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { callOk, callRejected, createFixture } from "./helpers/mcp-fixture.js";

test("filesystem read handlers return actual fixture bytes, metadata and bounded search results", async () => {
  const f = await createFixture();
  try {
    await fs.mkdir(path.join(f.root, "notes"));
    await fs.writeFile(path.join(f.root, "notes", "sample.txt"), "alpha\nbeta alpha\n", "utf8");
    await fs.writeFile(path.join(f.root, ".env"), "synthetic-only", "utf8");

    const info = await callOk(f, "workspace_info");
    assert.equal(info.defaultCwd, f.root);

    const stat = await callOk(f, "stat", { path: "notes/sample.txt" });
    assert.equal(stat.kind, "file");
    assert.equal(stat.size, 17);
    const many = await callOk(f, "stat_many", { paths: ["notes/sample.txt", "missing.txt"] });
    assert.deepEqual(many.entries.map((x: { exists: boolean }) => x.exists), [true, false]);

    const listing = await callOk(f, "list_dir", { path: "notes" });
    assert.ok(listing.entries.some((x: { name: string }) => x.name === "sample.txt"));
    const tree = await callOk(f, "tree", { path: ".", maxDepth: 2 });
    assert.ok(tree.entries.some((x: { relativePath: string }) => x.relativePath.replaceAll("\\", "/") === "notes/sample.txt"));

    const one = await callOk(f, "read_file", { path: "notes/sample.txt" });
    assert.equal(one.content, "alpha\nbeta alpha\n");
    const range = await callOk(f, "read_file_range", { path: "notes/sample.txt", offset: 6, length: 4 });
    assert.equal(range.content, "beta");
    const multiple = await callOk(f, "read_many", { paths: ["notes/sample.txt"] });
    assert.equal(multiple.files[0].content, "alpha\nbeta alpha\n");

    const hash = await callOk(f, "hash", { path: "notes/sample.txt" });
    assert.equal(hash.hash, crypto.createHash("sha256").update("alpha\nbeta alpha\n").digest("hex"));
    const search = await callOk(f, "search", { path: "notes", pattern: "alpha" });
    assert.deepEqual(search.matches.map((x: { line: number }) => x.line), [1, 2]);

    await callRejected(f, "read_file", { path: ".env" }, /sensitive path/i);
    await callRejected(f, "read_file", { path: path.join(f.root, "..", "outside.txt") }, /outside configured workspace/i);
  } finally {
    await f.close();
  }
});

test("filesystem mutation handlers honor dry-run, commit disposable changes and restore backups", async () => {
  const f = await createFixture();
  try {
    const mkdir = await callOk(f, "mkdir", { cwd: f.root, path: "working" });
    assert.equal(mkdir.path, path.join(f.root, "working"));
    const writeArgs = { cwd: f.root, path: "working/original.txt", content: "before\n" };
    const preview = await callOk(f, "write_file", writeArgs);
    assert.equal(preview.wouldCreate, true);
    await assert.rejects(fs.stat(path.join(f.root, "working", "original.txt")), { code: "ENOENT" });
    const created = await callOk(f, "write_file", { ...writeArgs, dryRun: false, confirm: true });
    assert.equal(created.dryRun, false);
    assert.equal(await fs.readFile(path.join(f.root, "working", "original.txt"), "utf8"), "before\n");

    const copyArgs = { cwd: f.root, from: "working/original.txt", to: "working/copied.txt" };
    const copyPreview = await callOk(f, "copy", copyArgs);
    assert.equal(copyPreview.dryRun, true);
    await assert.rejects(fs.stat(path.join(f.root, "working", "copied.txt")), { code: "ENOENT" });
    await callOk(f, "copy", { ...copyArgs, dryRun: false, confirm: true });
    assert.equal(await fs.readFile(path.join(f.root, "working", "copied.txt"), "utf8"), "before\n");

    const moveArgs = { cwd: f.root, from: "working/copied.txt", to: "working/moved.txt" };
    await callOk(f, "move", { ...moveArgs, dryRun: false, confirm: true });
    await assert.rejects(fs.stat(path.join(f.root, "working", "copied.txt")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(f.root, "working", "moved.txt"), "utf8"), "before\n");

    const deleteArgs = { cwd: f.root, path: "working/moved.txt" };
    const deletePreview = await callOk(f, "delete", deleteArgs);
    assert.equal(deletePreview.wouldDelete, true);
    assert.equal(await fs.readFile(path.join(f.root, "working", "moved.txt"), "utf8"), "before\n");
    await callRejected(f, "delete", { ...deleteArgs, dryRun: false }, /confirm=true/i);
    const deleted = await callOk(f, "delete", { ...deleteArgs, dryRun: false, confirm: true });
    await assert.rejects(fs.stat(path.join(f.root, "working", "moved.txt")), { code: "ENOENT" });
    assert.equal(deleted.backupIds.length, 1);

    const restored = await callOk(f, "rollback_backup", { backupId: deleted.backupIds[0], dryRun: false, confirm: true });
    assert.equal(restored.restored, true);
    assert.equal(await fs.readFile(path.join(f.root, "working", "moved.txt"), "utf8"), "before\n");
  } finally {
    await f.close();
  }
});

test("apply_patch checks the diff and changes only a disposable fixture file", async () => {
  const f = await createFixture();
  try {
    await fs.writeFile(path.join(f.root, "change.txt"), "before\n", "utf8");
    const patch = [
      "diff --git a/change.txt b/change.txt",
      "--- a/change.txt",
      "+++ b/change.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const dry = await callOk(f, "apply_patch", { cwd: f.root, patch });
    assert.equal(dry.code, 0);
    assert.equal(await fs.readFile(path.join(f.root, "change.txt"), "utf8"), "before\n");
    const applied = await callOk(f, "apply_patch", { cwd: f.root, patch, dryRun: false, confirm: true });
    assert.equal(applied.code, 0);
    assert.equal((await fs.readFile(path.join(f.root, "change.txt"), "utf8")).replaceAll("\r\n", "\n"), "after\n");
  } finally {
    await f.close();
  }
});
