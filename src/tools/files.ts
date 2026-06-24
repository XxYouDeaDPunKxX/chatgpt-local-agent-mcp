import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BackupRecord, assertBackupsRestorable, createFileBackup, restorableBackupIds } from "../backup.js";
import { errorText, jsonText } from "../format.js";
import { assertPathTargetAllowed, assertPolicyModeAllowed, isSensitivePath } from "../guards.js";
import { getFileSnapshot, redactArgs, runJournaledMutation } from "../journal.js";
import { McpRuntime } from "../mcp.js";
import { cwdBreadthWarning, resolveCwd, resolveFromCwd } from "../paths.js";
import { requireScope } from "../runtime.js";
import { SCOPES } from "../scopes.js";
import { INSTRUCTION_SAFETY_NOTE, sourceTrustForPath } from "../source-trust.js";

const LIST_DIR_DEFAULT_MAX_ENTRIES = 500;
const LIST_DIR_HARD_MAX_ENTRIES = 5_000;
const LIST_DIR_STAT_CONCURRENCY = 32;
const READ_MANY_MAX_FILES = 50;
const READ_MANY_HARD_MAX_TOTAL_BYTES = 10_000_000;
const STAT_MANY_MAX_PATHS = 200;
const TREE_DEFAULT_MAX_DEPTH = 3;
const TREE_HARD_MAX_DEPTH = 20;
const TREE_DEFAULT_MAX_ENTRIES = 1_000;
const TREE_HARD_MAX_ENTRIES = 10_000;
const TREE_DEFAULT_EXCLUDE_NAMES = new Set([".git", "node_modules", "dist", "data", "coverage", ".next"]);
const HASH_DEFAULT_MAX_BYTES = 100_000_000;
const HASH_HARD_MAX_BYTES = 1_000_000_000;

type TreeEntry = {
  depth: number;
  error?: string;
  kind: "directory" | "file" | "symlink" | "other" | "unavailable";
  path: string;
  relativePath: string;
  size?: number;
};

const statOutputSchema = {
  createdAt: z.string().optional(),
  exists: z.boolean(),
  isSymlink: z.boolean().optional(),
  kind: z.enum(["directory", "file", "symlink", "other", "missing"]),
  modifiedAt: z.string().optional(),
  path: z.string(),
  size: z.number().optional(),
};

function kindFromDirent(entry: Dirent): "directory" | "file" | "symlink" | "other" {
  return entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other";
}

function kindFromStats(stats: Awaited<ReturnType<typeof fs.stat>>, isSymlink = false): "directory" | "file" | "symlink" | "other" {
  if (isSymlink) return "symlink";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

async function statPath(filePath: string) {
  try {
    const lstat = await fs.lstat(filePath);
    const isSymlink = lstat.isSymbolicLink();
    const stats = isSymlink ? await fs.stat(filePath).catch(() => lstat) : lstat;
    return {
      createdAt: stats.birthtime.toISOString(),
      exists: true,
      isSymlink,
      kind: kindFromStats(stats, isSymlink),
      modifiedAt: stats.mtime.toISOString(),
      path: filePath,
      size: stats.size,
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return {
        exists: false,
        kind: "missing" as const,
        path: filePath,
      };
    }
    throw error;
  }
}

async function hashFile(filePath: string, algorithm: "sha256" | "sha1" | "md5"): Promise<string> {
  const hash = createHash(algorithm);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer | string) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function readFileRange(
  filePath: string,
  offset: number,
  length: number,
  encoding: BufferEncoding,
): Promise<{ bytesRead: number; content: string }> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return {
      bytesRead,
      content: buffer.subarray(0, bytesRead).toString(encoding),
    };
  } finally {
    await handle.close();
  }
}

async function mapConcurrent<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readBoundedDirectoryEntries(
  directoryPath: string,
  includeHidden: boolean,
  maxEntries: number,
): Promise<{ entries: Dirent[]; truncated: boolean }> {
  const entries: Dirent[] = [];
  const directory = await fs.opendir(directoryPath);
  let truncated = false;

  try {
    for await (const entry of directory) {
      if (!includeHidden && entry.name.startsWith(".")) {
        continue;
      }
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }

  return { entries, truncated };
}

async function fsyncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows and some filesystems do not allow syncing directories.
  }
}

async function atomicWriteFile(filePath: string, content: string, encoding: BufferEncoding): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let tempCreated = false;

  try {
    const handle = await fs.open(tempPath, "w");
    tempCreated = true;
    try {
      await handle.writeFile(content, encoding);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(tempPath, filePath);
    tempCreated = false;
    await fsyncDirectoryBestEffort(directory);
  } finally {
    if (tempCreated) {
      await fs.rm(tempPath, { force: true });
    }
  }
}

async function missingParentDirectories(filePath: string): Promise<string[]> {
  const missing: string[] = [];
  let current = path.dirname(filePath);
  const root = path.parse(current).root;

  while (current && current !== root) {
    try {
      const stats = await fs.stat(current);
      if (!stats.isDirectory()) {
        break;
      }
      break;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
      missing.push(current);
      current = path.dirname(current);
    }
  }

  return missing.reverse();
}

export function registerStatTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "stat",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description: "Return metadata for a local path.",
      inputSchema: {
        cwd: z.string().optional().describe("Base directory for relative path resolution."),
        path: z.string().describe("Path to inspect."),
      },
      outputSchema: statOutputSchema,
      title: "Stat Path",
    },
    async ({ cwd, path: inputPath }) => {
      const startedAt = Date.now();
      let resolvedCwd = cwd || runtime.config.defaultCwd;
      try {
        requireScope(runtime.context, SCOPES.read);
        resolvedCwd = await resolveCwd(resolvedCwd);
        const absolutePath = resolveFromCwd(resolvedCwd, inputPath);
        assertPolicyModeAllowed(runtime.config, "observe");
        await assertPathTargetAllowed(runtime.config, absolutePath, "observe", { checkSecret: true });
        const result = await statPath(absolutePath);
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, path: inputPath }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "success",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "stat",
        });
        return jsonText(result);
      } catch (error) {
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, path: inputPath }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "stat",
        });
        return errorText(error);
      }
    },
  );
}

export function registerStatManyTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "stat_many",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description: "Return metadata for multiple local paths.",
      inputSchema: {
        cwd: z.string().optional().describe("Base directory for relative path resolution."),
        paths: z.array(z.string()).min(1).max(STAT_MANY_MAX_PATHS).describe("Paths to inspect."),
      },
      outputSchema: { entries: z.array(z.object(statOutputSchema)) },
      title: "Stat Many Paths",
    },
    async ({ cwd, paths }) => {
      const startedAt = Date.now();
      let resolvedCwd = cwd || runtime.config.defaultCwd;
      try {
        requireScope(runtime.context, SCOPES.read);
        resolvedCwd = await resolveCwd(resolvedCwd);
        assertPolicyModeAllowed(runtime.config, "observe");
        const entries = await mapConcurrent(paths, LIST_DIR_STAT_CONCURRENCY, async (inputPath) => {
          const absolutePath = resolveFromCwd(resolvedCwd, inputPath);
          await assertPathTargetAllowed(runtime.config, absolutePath, "observe", { checkSecret: true });
          return statPath(absolutePath);
        });
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, paths }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "success",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "stat_many",
        });
        return jsonText({ entries });
      } catch (error) {
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, paths }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "stat_many",
        });
        return errorText(error);
      }
    },
  );
}

export function registerReadFileRangeTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "read_file_range",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description: "Read a byte range from a local file.",
      inputSchema: {
        cwd: z.string().optional().describe("Base directory for relative path resolution."),
        encoding: z.enum(["utf8", "base64"]).optional().default("utf8"),
        length: z.number().int().positive().max(10_000_000).describe("Maximum bytes to read."),
        offset: z.number().int().nonnegative().default(0).describe("Byte offset to start reading from."),
        path: z.string().describe("File path to read."),
      },
      outputSchema: {
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]),
        instructionSafety: z.string(),
        length: z.number(),
        offset: z.number(),
        path: z.string(),
        sourceTrust: z.enum(["local_workspace_content", "untrusted_external_content"]),
      },
      title: "Read File Range",
    },
    async ({ cwd, encoding, length, offset, path: inputPath }) => {
      const startedAt = Date.now();
      let resolvedCwd = cwd || runtime.config.defaultCwd;
      try {
        requireScope(runtime.context, SCOPES.read);
        resolvedCwd = await resolveCwd(resolvedCwd);
        const absolutePath = resolveFromCwd(resolvedCwd, inputPath);
        assertPolicyModeAllowed(runtime.config, "observe");
        await assertPathTargetAllowed(runtime.config, absolutePath, "observe", { checkSecret: true });
        const effectiveLength = Math.min(
          length,
          encoding === "base64" ? Math.floor(runtime.config.maxOutputBytes * 0.75) : runtime.config.maxOutputBytes,
        );
        const range = await readFileRange(absolutePath, offset, effectiveLength, encoding);
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, encoding, length, offset, path: inputPath }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          effects: [{ operation: "read", path: absolutePath }],
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "success",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "read_file_range",
        });
        return jsonText({
          content: range.content,
          encoding,
          instructionSafety: INSTRUCTION_SAFETY_NOTE,
          length: range.bytesRead,
          offset,
          path: absolutePath,
          sourceTrust: sourceTrustForPath(absolutePath),
        });
      } catch (error) {
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, encoding, length, offset, path: inputPath }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "read_file_range",
        });
        return errorText(error);
      }
    },
  );
}

export function registerReadManyTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "read_many",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description: "Read multiple local files.",
      inputSchema: {
        cwd: z.string().optional().describe("Base directory for relative path resolution."),
        encoding: z.enum(["utf8", "base64"]).optional().default("utf8"),
        maxBytesPerFile: z.number().int().positive().max(10_000_000).optional(),
        maxTotalBytes: z.number().int().positive().max(READ_MANY_HARD_MAX_TOTAL_BYTES).optional(),
        paths: z.array(z.string()).min(1).max(READ_MANY_MAX_FILES).describe("Files to read."),
      },
      outputSchema: {
        files: z.array(
          z.object({
            bytesRead: z.number().optional(),
            bytesTotal: z.number().optional(),
            content: z.string().optional(),
            encoding: z.enum(["utf8", "base64"]).optional(),
            error: z.string().optional(),
            instructionSafety: z.string().optional(),
            path: z.string(),
            sourceTrust: z.enum(["local_workspace_content", "untrusted_external_content"]).optional(),
            truncated: z.boolean().optional(),
          }),
        ),
        maxTotalBytes: z.number(),
        totalBytesRead: z.number(),
        truncated: z.boolean(),
      },
      title: "Read Many Files",
    },
    async ({ cwd, encoding, maxBytesPerFile, maxTotalBytes, paths }) => {
      const startedAt = Date.now();
      let resolvedCwd = cwd || runtime.config.defaultCwd;
      try {
        requireScope(runtime.context, SCOPES.read);
        resolvedCwd = await resolveCwd(resolvedCwd);
        assertPolicyModeAllowed(runtime.config, "observe");
        const limit = maxBytesPerFile || runtime.config.maxOutputBytes;
        const rawLimit = encoding === "base64" ? Math.floor(limit * 0.75) : limit;
        const totalLimit = maxTotalBytes || runtime.config.maxOutputBytes;
        const rawTotalLimit = encoding === "base64" ? Math.floor(totalLimit * 0.75) : totalLimit;
        let totalBytesRead = 0;
        let truncated = false;
        const files = [];

        for (const inputPath of paths) {
          const absolutePath = resolveFromCwd(resolvedCwd, inputPath);
          try {
            if (totalBytesRead >= rawTotalLimit) {
              truncated = true;
              files.push({ error: "Total read_many output budget exhausted", path: absolutePath, truncated: true });
              continue;
            }
            await assertPathTargetAllowed(runtime.config, absolutePath, "observe", { checkSecret: true });
            const stats = await fs.stat(absolutePath);
            if (!stats.isFile()) throw new Error(`Not a file: ${absolutePath}`);
            if (stats.size > rawLimit) throw new Error(`File too large: ${stats.size} bytes > ${rawLimit}`);
            const remaining = rawTotalLimit - totalBytesRead;
            const bytesToRead = Math.min(stats.size, remaining);
            const range = await readFileRange(absolutePath, 0, bytesToRead, encoding);
            totalBytesRead += range.bytesRead;
            if (range.bytesRead < stats.size) {
              truncated = true;
            }
            files.push({
              bytesRead: range.bytesRead,
              bytesTotal: stats.size,
              content: range.content,
              encoding,
              instructionSafety: INSTRUCTION_SAFETY_NOTE,
              path: absolutePath,
              sourceTrust: sourceTrustForPath(absolutePath),
              truncated: range.bytesRead < stats.size,
            });
          } catch (error) {
            files.push({ error: error instanceof Error ? error.message : String(error), path: absolutePath });
          }
        }
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, encoding, maxBytesPerFile, maxTotalBytes, paths }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "success",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "read_many",
        });
        return jsonText({ files, maxTotalBytes: totalLimit, totalBytesRead, truncated });
      } catch (error) {
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, encoding, maxBytesPerFile, maxTotalBytes, paths }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "read_many",
        });
        return errorText(error);
      }
    },
  );
}

export function registerHashTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "hash",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description: "Hash a local file.",
      inputSchema: {
        algorithm: z.enum(["sha256", "sha1", "md5"]).optional().default("sha256"),
        cwd: z.string().optional().describe("Base directory for relative path resolution."),
        maxBytes: z.number().int().positive().max(HASH_HARD_MAX_BYTES).optional().default(HASH_DEFAULT_MAX_BYTES),
        path: z.string().describe("File to hash."),
      },
      outputSchema: {
        algorithm: z.enum(["sha256", "sha1", "md5"]),
        bytesHashed: z.number(),
        hash: z.string(),
        maxBytes: z.number(),
        path: z.string(),
      },
      title: "Hash File",
    },
    async ({ algorithm, cwd, maxBytes, path: inputPath }) => {
      const startedAt = Date.now();
      let resolvedCwd = cwd || runtime.config.defaultCwd;
      try {
        requireScope(runtime.context, SCOPES.read);
        resolvedCwd = await resolveCwd(resolvedCwd);
        const absolutePath = resolveFromCwd(resolvedCwd, inputPath);
        assertPolicyModeAllowed(runtime.config, "observe");
        await assertPathTargetAllowed(runtime.config, absolutePath, "observe", { checkSecret: true });
        const stats = await fs.stat(absolutePath);
        if (!stats.isFile()) {
          throw new Error(`Not a file: ${absolutePath}`);
        }
        if (stats.size > maxBytes) {
          throw new Error(`File too large to hash: ${stats.size} bytes > ${maxBytes}`);
        }
        const digest = await hashFile(absolutePath, algorithm);
        await runtime.journal.append({
          argsRedacted: redactArgs({ algorithm, cwd, maxBytes, path: inputPath }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "success",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "hash",
        });
        return jsonText({ algorithm, bytesHashed: stats.size, hash: digest, maxBytes, path: absolutePath });
      } catch (error) {
        await runtime.journal.append({
          argsRedacted: redactArgs({ algorithm, cwd, maxBytes, path: inputPath }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "hash",
        });
        return errorText(error);
      }
    },
  );
}

export function registerTreeTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "tree",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description: "Return a bounded recursive tree of a directory.",
      inputSchema: {
        cwd: z.string().optional().describe("Base directory for relative path resolution."),
        excludeDefaults: z.boolean().optional().default(true),
        includeHidden: z.boolean().optional().default(false),
        maxDepth: z.number().int().nonnegative().max(TREE_HARD_MAX_DEPTH).optional().default(TREE_DEFAULT_MAX_DEPTH),
        maxEntries: z.number().int().positive().max(TREE_HARD_MAX_ENTRIES).optional().default(TREE_DEFAULT_MAX_ENTRIES),
        path: z.string().optional().default(".").describe("Directory to inspect."),
      },
      outputSchema: {
        blockedEntries: z.number(),
        entries: z.array(
          z.object({
            depth: z.number(),
            error: z.string().optional(),
            kind: z.enum(["directory", "file", "symlink", "other", "unavailable"]),
            path: z.string(),
            relativePath: z.string(),
            size: z.number().optional(),
          }),
        ),
        excludedEntries: z.number(),
        root: z.string(),
        truncated: z.boolean(),
      },
      title: "Directory Tree",
    },
    async ({ cwd, excludeDefaults, includeHidden, maxDepth, maxEntries, path: inputPath }) => {
      const startedAt = Date.now();
      let resolvedCwd = cwd || runtime.config.defaultCwd;
      try {
        requireScope(runtime.context, SCOPES.read);
        resolvedCwd = await resolveCwd(resolvedCwd);
        const root = resolveFromCwd(resolvedCwd, inputPath);
        assertPolicyModeAllowed(runtime.config, "observe");
        await assertPathTargetAllowed(runtime.config, root, "observe", { checkSecret: true });
        const entries: TreeEntry[] = [];
        let blockedEntries = 0;
        let excludedEntries = 0;
        let truncated = false;
        const stack: Array<{ depth: number; directory: string }> = [{ depth: 0, directory: root }];
        while (stack.length && entries.length < maxEntries) {
          const { depth, directory } = stack.pop()!;
          let dir: Awaited<ReturnType<typeof fs.opendir>>;
          try {
            dir = await fs.opendir(directory);
          } catch (error) {
            entries.push({
              depth,
              error: error instanceof Error ? error.message : String(error),
              kind: "unavailable",
              path: directory,
              relativePath: path.relative(root, directory) || ".",
            });
            if (entries.length >= maxEntries) {
              truncated = true;
            }
            continue;
          }
          try {
            for await (const entry of dir) {
              if (!includeHidden && entry.name.startsWith(".")) continue;
              if (excludeDefaults && TREE_DEFAULT_EXCLUDE_NAMES.has(entry.name)) {
                excludedEntries += 1;
                continue;
              }
              const entryPath = path.join(directory, entry.name);
              if (isSensitivePath(runtime.config, entryPath)) {
                blockedEntries += 1;
                continue;
              }
              try {
                await assertPathTargetAllowed(runtime.config, entryPath, "observe", { checkSecret: true });
              } catch {
                blockedEntries += 1;
                continue;
              }
              const stats = await fs.stat(entryPath).catch(() => undefined);
              entries.push({
                depth: depth + 1,
                kind: kindFromDirent(entry),
                path: entryPath,
                relativePath: path.relative(root, entryPath),
                size: stats?.size,
              });
              if (entries.length >= maxEntries) {
                truncated = true;
                break;
              }
              if (entry.isDirectory() && depth + 1 < maxDepth) {
                stack.push({ depth: depth + 1, directory: entryPath });
              }
            }
          } finally {
            await dir.close().catch(() => undefined);
          }
        }
        if (stack.length) truncated = true;
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, excludeDefaults, includeHidden, maxDepth, maxEntries, path: inputPath }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "success",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "tree",
        });
        return jsonText({ blockedEntries, entries, excludedEntries, root, truncated });
      } catch (error) {
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, excludeDefaults, includeHidden, maxDepth, maxEntries, path: inputPath }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "tree",
        });
        return errorText(error);
      }
    },
  );
}

export function registerListDirTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "list_dir",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description: "List directory entries on the local machine. Use this to inspect filesystem state.",
      inputSchema: {
        cwd: z.string().optional().describe("Base directory for relative path resolution."),
        includeHidden: z.boolean().optional().default(true),
        maxEntries: z
          .number()
          .int()
          .positive()
          .max(LIST_DIR_HARD_MAX_ENTRIES)
          .optional()
          .default(LIST_DIR_DEFAULT_MAX_ENTRIES),
        path: z.string().describe("Directory path to list. Relative paths resolve against cwd or process cwd."),
      },
      outputSchema: {
        blockedEntries: z.number(),
        entries: z.array(
          z.object({
            error: z.string().optional(),
            modifiedAt: z.string().optional(),
            name: z.string(),
            path: z.string(),
            size: z.number().optional(),
            type: z.enum(["directory", "file", "symlink", "other", "unavailable"]),
          }),
        ),
        entriesReturned: z.number(),
        path: z.string(),
        truncated: z.boolean(),
      },
      title: "List Directory",
    },
    async ({ cwd, includeHidden, maxEntries, path: inputPath }) => {
      const startedAt = Date.now();
      let resolvedCwd = cwd || runtime.config.defaultCwd;
      try {
        resolvedCwd = await resolveCwd(resolvedCwd);
        const absolutePath = resolveFromCwd(resolvedCwd, inputPath);
        requireScope(runtime.context, SCOPES.read);
        assertPolicyModeAllowed(runtime.config, "observe");
        await assertPathTargetAllowed(runtime.config, absolutePath, "observe", { checkSecret: true });
        const { entries, truncated } = await readBoundedDirectoryEntries(absolutePath, includeHidden, maxEntries);
        const result = await mapConcurrent(entries, LIST_DIR_STAT_CONCURRENCY, async (entry) => {
          const entryPath = path.join(absolutePath, entry.name);
          if (isSensitivePath(runtime.config, entryPath)) {
            return undefined;
          }
          try {
            await assertPathTargetAllowed(runtime.config, entryPath, "observe", { checkSecret: true });
            const stats = await fs.lstat(entryPath);
            return {
              modifiedAt: stats.mtime.toISOString(),
              name: entry.name,
              path: entryPath,
              size: stats.size,
              type: stats.isDirectory()
                ? "directory"
                : stats.isFile()
                  ? "file"
                  : stats.isSymbolicLink()
                    ? "symlink"
                    : "other",
            };
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : String(error),
              name: entry.name,
              path: entryPath,
              type: "unavailable",
            };
          }
        });
        const visibleEntries = result.filter((entry): entry is Exclude<(typeof result)[number], undefined> => entry !== undefined);
        const blockedEntries = result.length - visibleEntries.length;
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, includeHidden, maxEntries, path: inputPath }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "success",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "list_dir",
        });
        return jsonText({
          blockedEntries,
          entries: visibleEntries,
          entriesReturned: visibleEntries.length,
          path: absolutePath,
          truncated,
        });
      } catch (error) {
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, includeHidden, maxEntries, path: inputPath }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "list_dir",
        });
        return errorText(error);
      }
    },
  );
}

export function registerReadFileTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "read_file",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description: "Read a local text file from the machine running the MCP server.",
      inputSchema: {
        cwd: z.string().optional().describe("Base directory for relative path resolution."),
        encoding: z.enum(["utf8", "base64"]).optional().default("utf8"),
        maxBytes: z.number().int().positive().max(10_000_000).optional(),
        path: z.string().describe("File path to read. Relative paths resolve against cwd or process cwd."),
      },
      outputSchema: {
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]),
        instructionSafety: z.string(),
        path: z.string(),
        sourceTrust: z.enum(["local_workspace_content", "untrusted_external_content"]),
      },
      title: "Read File",
    },
    async ({ cwd, encoding, maxBytes, path: inputPath }) => {
      const startedAt = Date.now();
      let resolvedCwd = cwd || runtime.config.defaultCwd;
      try {
        resolvedCwd = await resolveCwd(resolvedCwd);
        const absolutePath = resolveFromCwd(resolvedCwd, inputPath);
        requireScope(runtime.context, SCOPES.read);
        assertPolicyModeAllowed(runtime.config, "observe");
        await assertPathTargetAllowed(runtime.config, absolutePath, "observe", { checkSecret: true });
        const stats = await fs.stat(absolutePath);
        const limit = maxBytes || runtime.config.maxOutputBytes;
        const rawLimit = encoding === "base64" ? Math.floor(limit * 0.75) : limit;
        if (stats.size > rawLimit) {
          throw new Error(`File too large: ${stats.size} bytes > ${rawLimit} raw bytes for ${encoding} output limit ${limit}`);
        }
        const content = await fs.readFile(absolutePath, encoding);
        const snapshot = await getFileSnapshot(absolutePath, runtime.config.maxOutputBytes);
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, encoding, maxBytes, path: inputPath }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          effects: [
            {
              bytesAfter: snapshot.size,
              operation: "read",
              path: absolutePath,
            },
          ],
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "success",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "read_file",
        });
        return jsonText({
          content,
          encoding,
          instructionSafety: INSTRUCTION_SAFETY_NOTE,
          path: absolutePath,
          sourceTrust: sourceTrustForPath(absolutePath),
        });
      } catch (error) {
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, encoding, maxBytes, path: inputPath }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "read_file",
        });
        return errorText(error);
      }
    },
  );
}

export function registerWriteFileTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "write_file",
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Preferred tool for creating or replacing a local text file. Use this instead of shell redirection, Set-Content, Out-File, echo > file, or heredoc writes when writing a whole file. Prefer the narrowest practical cwd plus a short relative path; the tool returns warnings when cwd is broader than the target.",
      inputSchema: {
        confirm: z.boolean().optional().default(false),
        content: z.string().describe("Content to write."),
        cwd: z.string().describe("Required base directory for relative path resolution."),
        createParents: z.boolean().optional().default(false),
        dryRun: z.boolean().optional().default(true),
        encoding: z.enum(["utf8", "base64"]).optional().default("utf8"),
        path: z.string().describe("File path to write. Relative paths resolve against cwd or process cwd."),
      },
      outputSchema: {
        auditQuality: z.enum(["granular"]),
        backupIds: z.array(z.string()),
        bytesWritten: z.number(),
        confirmed: z.boolean(),
        dryRun: z.boolean(),
        path: z.string(),
        warnings: z
          .array(
            z.object({
              code: z.string(),
              cwd: z.string().optional(),
              message: z.string(),
              path: z.string().optional(),
              severity: z.enum(["info", "warning"]),
              suggestion: z.string().optional(),
            }),
          )
          .optional(),
        wouldCreate: z.boolean(),
        wouldOverwrite: z.boolean(),
      },
      title: "Write File",
    },
    async ({ confirm, content, createParents, dryRun, cwd, encoding, path: inputPath }) => {
      const startedAt = Date.now();
      let resolvedCwd = cwd;
      let mutationStarted = false;
      const backupRecords: BackupRecord[] = [];
      try {
        resolvedCwd = await resolveCwd(resolvedCwd);
        const absolutePath = resolveFromCwd(resolvedCwd, inputPath);
        requireScope(runtime.context, SCOPES.write);
        assertPolicyModeAllowed(runtime.config, "destructive");
        await assertPathTargetAllowed(runtime.config, absolutePath, "destructive", { checkSecret: true });
        const bytesToWrite = Buffer.byteLength(content, encoding);
        if (bytesToWrite > runtime.config.maxOutputBytes) {
          throw new Error(`Content too large: ${bytesToWrite} bytes > ${runtime.config.maxOutputBytes}`);
        }
        const before = await getFileSnapshot(absolutePath, runtime.config.maxOutputBytes);
        const warnings = [cwdBreadthWarning(resolvedCwd, absolutePath)].filter(
          (warning): warning is NonNullable<typeof warning> => warning !== undefined,
        );
        if (!dryRun && before.exists && !confirm) {
          throw new Error("confirm=true is required when overwriting an existing file");
        }
        if (dryRun) {
          return jsonText({
            auditQuality: "granular",
            backupIds: [],
            bytesWritten: bytesToWrite,
            confirmed: confirm,
            dryRun: true,
            path: absolutePath,
            warnings,
            wouldCreate: !before.exists,
            wouldOverwrite: before.exists,
          });
        }
        const parentDirectories = createParents ? await missingParentDirectories(absolutePath) : [];
        const parentEffects = parentDirectories.map((directoryPath) => ({
          operation: "mkdir" as const,
          path: directoryPath,
        }));

        mutationStarted = true;
        await runJournaledMutation({
          afterSnapshot: async () => {
            const after = await getFileSnapshot(absolutePath, runtime.config.maxOutputBytes);
            return [
              ...parentEffects,
              {
                afterHash: after.hash,
                bytesAfter: after.size,
                operation: before.exists ? "write" : "create",
                path: absolutePath,
              },
            ];
          },
          argsRedacted: redactArgs({ confirm, content, createParents, dryRun, cwd, encoding, path: inputPath }),
          beforeSnapshot: async () => [
            ...parentEffects,
            {
              beforeHash: before.hash,
              bytesBefore: before.size,
              operation: before.exists ? "write" : "create",
              path: absolutePath,
            },
          ],
          cwd: resolvedCwd,
          effect: async () => {
            if (createParents) {
              await fs.mkdir(path.dirname(absolutePath), { recursive: true });
            }
            if (before.exists) {
              backupRecords.push(await createFileBackup(runtime.config, absolutePath, "write_file"));
              assertBackupsRestorable(backupRecords, { allowMissing: false });
            }
            await atomicWriteFile(absolutePath, content, encoding);
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          outcomeDetails: () => ({ backupIds: restorableBackupIds(backupRecords) }),
          requiredScope: SCOPES.write,
          requestId: runtime.context.requestId,
          tool: "write_file",
        });
        return jsonText({
          auditQuality: "granular",
          backupIds: restorableBackupIds(backupRecords),
          bytesWritten: bytesToWrite,
          confirmed: confirm,
          dryRun: false,
          path: absolutePath,
          warnings,
          wouldCreate: !before.exists,
          wouldOverwrite: before.exists,
        });
      } catch (error) {
        if (!mutationStarted) {
          await runtime.journal.append({
            argsRedacted: redactArgs({ confirm, content, createParents, dryRun, cwd, encoding, path: inputPath }),
            cwd: resolvedCwd,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
            id: runtime.context.requestId,
            identity: runtime.context.identity,
            outcome: "error",
            requiredScope: SCOPES.write,
            timestamp: new Date().toISOString(),
            tool: "write_file",
          });
        }
        return errorText(error);
      }
    },
  );
}
