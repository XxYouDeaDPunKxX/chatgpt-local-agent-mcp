import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BackupRecord, assertBackupsRestorable, createFileBackup, readBackupRecord, restorableBackupIds } from "../backup.js";
import { BoundedCommandResult, runBoundedCommand } from "../command.js";
import { errorText, jsonText } from "../format.js";
import {
  assertPathTargetAllowed,
  assertPathTargetsAllowed,
  assertPolicyModeAllowed,
  isSensitivePath,
} from "../guards.js";
import { FileEffect, getFileSnapshot, redactArgs, runJournaledMutation, runJournaledOperation } from "../journal.js";
import { McpRuntime } from "../mcp.js";
import { resolveCwd, resolveFromCwd } from "../paths.js";
import { requireScope } from "../runtime.js";
import { SCOPES } from "../scopes.js";
import { INSTRUCTION_SAFETY_NOTE } from "../source-trust.js";

const SEARCH_DEFAULT_MAX_FILES = 1_000;
const SEARCH_DEFAULT_MAX_MATCHES = 200;
const SEARCH_MAX_FILE_BYTES = 2_000_000;
const SEARCH_MAX_REGEX_LENGTH = 500;

const commandResultOutputSchema = {
  code: z.union([z.number(), z.null()]),
  outputLimitExceeded: z.boolean(),
  signal: z.union([z.string(), z.null()]),
  stderr: z.string(),
  stderrTruncated: z.boolean(),
  stdout: z.string(),
  stdoutTruncated: z.boolean(),
  timedOut: z.boolean(),
};

const pathOutputSchema = {
  path: z.string(),
};

const backupIdsOutputSchema = {
  backupIds: z.array(z.string()),
};

const dryRunOutputSchema = {
  confirmed: z.boolean(),
  dryRun: z.boolean(),
};

type CommandResult = BoundedCommandResult;

async function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  input: string | undefined,
  maxOutputBytes: number,
  timeoutMs: number,
): Promise<CommandResult> {
  return runBoundedCommand({
    args,
    cwd,
    executable,
    input,
    maxOutputBytes,
    timeoutMs,
  });
}

function requireConfirmedExecution(dryRun: boolean, confirm: boolean): void {
  if (!dryRun && !confirm) {
    throw new Error("confirm=true is required when dryRun=false");
  }
}

function commandSucceeded(command: CommandResult): boolean {
  return command.code === 0 && !command.timedOut && !command.outputLimitExceeded;
}

async function fsyncPathBestEffort(filePath: string): Promise<void> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows and some filesystems do not allow syncing every path type.
  }
}

async function atomicCopyFile(sourcePath: string, destinationPath: string): Promise<void> {
  const directory = path.dirname(destinationPath);
  const tempPath = path.join(directory, `.${path.basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`);
  let tempCreated = false;

  try {
    await fs.copyFile(sourcePath, tempPath);
    tempCreated = true;
    await fsyncPathBestEffort(tempPath);
    await fs.rename(tempPath, destinationPath);
    tempCreated = false;
    await fsyncPathBestEffort(directory);
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

function shouldSkipSensitivePath(runtime: McpRuntime, filePath: string): boolean {
  return isSensitivePath(runtime.config, filePath);
}

function assertSafeSearchRegex(pattern: string): void {
  if (pattern.length > SEARCH_MAX_REGEX_LENGTH) {
    throw new Error(`Regex pattern too long: ${pattern.length} > ${SEARCH_MAX_REGEX_LENGTH}`);
  }
  if (/(?:\([^)]*[+*][^)]*\)|\[[^\]]+\]|\.[+*]|\S[+*])\s*[+*{]/.test(pattern)) {
    throw new Error("Regex pattern rejected because it contains nested or stacked quantifiers");
  }
  if (/\\[1-9]/.test(pattern)) {
    throw new Error("Regex pattern rejected because backreferences are not allowed");
  }
}

function touchedFilesFromPatch(patch: string, cwd: string): string[] {
  const touched = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const match =
      /^diff --git a\/(.+?) b\/(.+)$/.exec(line) ||
      /^\+\+\+ b\/(.+)$/.exec(line) ||
      /^--- a\/(.+)$/.exec(line);
    if (!match) continue;
    for (const item of match.slice(1)) {
      if (!item || item === "/dev/null") continue;
      touched.add(path.resolve(cwd, item));
    }
  }
  return [...touched];
}

async function pathEffect(targetPath: string, operation: FileEffect["operation"]): Promise<FileEffect> {
  try {
    const stats = await fs.stat(targetPath);
    if (stats.isFile()) {
      const snapshot = await getFileSnapshot(targetPath, SEARCH_MAX_FILE_BYTES);
      return {
        afterHash: snapshot.hash,
        beforeHash: snapshot.hash,
        bytesAfter: snapshot.size,
        bytesBefore: snapshot.size,
        operation,
        path: targetPath,
      };
    }
    return {
      bytesAfter: stats.size,
      bytesBefore: stats.size,
      operation,
      path: targetPath,
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return { operation, path: targetPath };
    }
    throw error;
  }
}

async function* walkFiles(runtime: McpRuntime, root: string, includeHidden: boolean): AsyncGenerator<string> {
  const entries = await fs.opendir(root);
  try {
    for await (const entry of entries) {
      if (!includeHidden && entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const entryPath = path.join(root, entry.name);
      try {
        await assertPathTargetAllowed(runtime.config, entryPath, "diagnose", { checkSecret: true });
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        yield* walkFiles(runtime, entryPath, includeHidden);
      } else if (entry.isFile()) {
        yield entryPath;
      }
    }
  } finally {
    await entries.close().catch(() => undefined);
  }
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export function registerMkdirTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "mkdir",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
      description: "Preferred tool for creating directories. Use this instead of shell mkdir, md, or New-Item -ItemType Directory when practical.",
      inputSchema: {
        cwd: z.string().describe("Required base directory for relative path resolution."),
        path: z.string().describe("Directory path to create."),
        recursive: z.boolean().optional().default(true),
      },
      outputSchema: pathOutputSchema,
      title: "Create Directory",
    },
    async ({ cwd, path: inputPath, recursive }) => {
      try {
        requireScope(runtime.context, SCOPES.write);
        const resolvedCwd = await resolveCwd(cwd);
        const absolutePath = resolveFromCwd(resolvedCwd, inputPath);
        assertPolicyModeAllowed(runtime.config, "edit");
        await assertPathTargetAllowed(runtime.config, absolutePath, "edit", { checkSecret: true });
        await runJournaledMutation({
          afterSnapshot: async () => [await pathEffect(absolutePath, "mkdir")],
          argsRedacted: redactArgs({ cwd, path: inputPath, recursive }),
          beforeSnapshot: async () => [await pathEffect(absolutePath, "mkdir")],
          cwd: resolvedCwd,
          effect: async () => fs.mkdir(absolutePath, { recursive }),
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.write,
          requestId: runtime.context.requestId,
          tool: "mkdir",
        });
        return jsonText({ path: absolutePath });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerDeleteTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "delete",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description: "Preferred tool for deleting a file with dry-run, confirm, backup, and journal effects. Use this instead of shell Remove-Item, del, erase, or rm when practical. Directory deletion is intentionally not supported yet.",
      inputSchema: {
        confirm: z.boolean().optional().default(false),
        cwd: z.string().describe("Required base directory for relative path resolution."),
        dryRun: z.boolean().optional().default(true),
        path: z.string().describe("Path to delete."),
      },
      outputSchema: {
        ...backupIdsOutputSchema,
        ...dryRunOutputSchema,
        path: z.string(),
        wouldDelete: z.boolean(),
      },
      title: "Delete Path",
    },
    async ({ confirm, cwd, dryRun, path: inputPath }) => {
      try {
        requireScope(runtime.context, SCOPES.delete);
        const resolvedCwd = await resolveCwd(cwd);
        const absolutePath = resolveFromCwd(resolvedCwd, inputPath);
        assertPolicyModeAllowed(runtime.config, "destructive");
        await assertPathTargetAllowed(runtime.config, absolutePath, "destructive", { checkSecret: true });
        const targetStats = await fs.stat(absolutePath);
        if (!targetStats.isFile()) {
          throw new Error("delete currently supports files only");
        }
        requireConfirmedExecution(dryRun, confirm);
        if (dryRun) {
          return jsonText({ backupIds: [], confirmed: confirm, dryRun: true, path: absolutePath, wouldDelete: true });
        }
        const backupRecords: BackupRecord[] = [];
        await runJournaledMutation({
          afterSnapshot: async () => [await pathEffect(absolutePath, "delete")],
          argsRedacted: redactArgs({ confirm, cwd, dryRun, path: inputPath }),
          beforeSnapshot: async () => [await pathEffect(absolutePath, "delete")],
          cwd: resolvedCwd,
          effect: async () => {
            backupRecords.push(await createFileBackup(runtime.config, absolutePath, "delete"));
            assertBackupsRestorable(backupRecords, { allowMissing: false });
            await fs.rm(absolutePath, { force: false });
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          outcomeDetails: () => ({ backupIds: restorableBackupIds(backupRecords) }),
          requiredScope: SCOPES.delete,
          requestId: runtime.context.requestId,
          tool: "delete",
        });
        return jsonText({
          backupIds: restorableBackupIds(backupRecords),
          confirmed: confirm,
          dryRun: false,
          path: absolutePath,
          wouldDelete: true,
        });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerMoveTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "move",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description: "Preferred tool for moving or renaming a file with dry-run, confirm, backup, and journal effects. Use this instead of shell move, mv, Rename-Item, or Move-Item when practical. Directory moves are intentionally not supported yet.",
      inputSchema: {
        confirm: z.boolean().optional().default(false),
        cwd: z.string().describe("Required base directory for relative path resolution."),
        dryRun: z.boolean().optional().default(true),
        from: z.string().describe("Source path."),
        overwrite: z.boolean().optional().default(false),
        to: z.string().describe("Destination path."),
      },
      outputSchema: {
        ...backupIdsOutputSchema,
        ...dryRunOutputSchema,
        from: z.string(),
        to: z.string(),
        wouldOverwrite: z.boolean(),
      },
      title: "Move Path",
    },
    async ({ confirm, cwd, dryRun, from, overwrite, to }) => {
      try {
        requireScope(runtime.context, SCOPES.write);
        const resolvedCwd = await resolveCwd(cwd);
        const fromPath = resolveFromCwd(resolvedCwd, from);
        const toPath = resolveFromCwd(resolvedCwd, to);
        assertPolicyModeAllowed(runtime.config, "destructive");
        await assertPathTargetsAllowed(runtime.config, [fromPath, toPath], "destructive", { checkSecret: true });
        const sourceStats = await fs.stat(fromPath);
        if (!sourceStats.isFile()) {
          throw new Error("move currently supports files only");
        }
        requireConfirmedExecution(dryRun, confirm);
        if (dryRun) {
          let wouldOverwrite = false;
          try {
            await fs.stat(toPath);
            wouldOverwrite = true;
          } catch {
            wouldOverwrite = false;
          }
          return jsonText({ backupIds: [], confirmed: confirm, dryRun: true, from: fromPath, to: toPath, wouldOverwrite });
        }
        const backupRecords: BackupRecord[] = [];
        await runJournaledMutation({
          afterSnapshot: async () => [await pathEffect(fromPath, "move"), await pathEffect(toPath, "move")],
          argsRedacted: redactArgs({ confirm, cwd, dryRun, from, overwrite, to }),
          beforeSnapshot: async () => [await pathEffect(fromPath, "move"), await pathEffect(toPath, "move")],
          cwd: resolvedCwd,
          effect: async () => {
            backupRecords.push(await createFileBackup(runtime.config, fromPath, "move"));
            assertBackupsRestorable([backupRecords[backupRecords.length - 1]], { allowMissing: false });
            let targetExists = false;
            try {
              await fs.stat(toPath);
              targetExists = true;
            } catch (error) {
              const nodeError = error as NodeJS.ErrnoException;
              if (nodeError.code !== "ENOENT") {
                throw error;
              }
            }
            if (targetExists && !overwrite) {
              throw new Error(`Destination already exists: ${toPath}`);
            }
            if (overwrite) {
              backupRecords.push(await createFileBackup(runtime.config, toPath, "move"));
              assertBackupsRestorable([backupRecords[backupRecords.length - 1]], { allowMissing: true });
            }
            if (overwrite) await fs.rm(toPath, { force: true, recursive: true });
            await fs.rename(fromPath, toPath);
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          outcomeDetails: () => ({ backupIds: restorableBackupIds(backupRecords) }),
          requiredScope: SCOPES.write,
          requestId: runtime.context.requestId,
          tool: "move",
        });
        return jsonText({
          backupIds: restorableBackupIds(backupRecords),
          confirmed: confirm,
          dryRun: false,
          from: fromPath,
          to: toPath,
          wouldOverwrite: overwrite,
        });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerCopyTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "copy",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description: "Preferred tool for copying a file with dry-run, confirm, backup-on-overwrite, and journal effects. Use this instead of shell copy, cp, or Copy-Item when practical. Directory copy is intentionally not supported yet.",
      inputSchema: {
        confirm: z.boolean().optional().default(false),
        cwd: z.string().describe("Required base directory for relative path resolution."),
        dryRun: z.boolean().optional().default(true),
        from: z.string().describe("Source file path."),
        overwrite: z.boolean().optional().default(false),
        to: z.string().describe("Destination file path."),
      },
      outputSchema: {
        ...backupIdsOutputSchema,
        ...dryRunOutputSchema,
        bytesCopied: z.number().optional(),
        from: z.string(),
        to: z.string(),
        wouldOverwrite: z.boolean(),
      },
      title: "Copy File",
    },
    async ({ confirm, cwd, dryRun, from, overwrite, to }) => {
      try {
        requireScope(runtime.context, SCOPES.write);
        const resolvedCwd = await resolveCwd(cwd);
        const fromPath = resolveFromCwd(resolvedCwd, from);
        const toPath = resolveFromCwd(resolvedCwd, to);
        assertPolicyModeAllowed(runtime.config, "destructive");
        await assertPathTargetsAllowed(runtime.config, [fromPath, toPath], "destructive", { checkSecret: true });
        const sourceStats = await fs.stat(fromPath);
        if (!sourceStats.isFile()) {
          throw new Error(`Source is not a file: ${fromPath}`);
        }
        let wouldOverwrite = false;
        try {
          await fs.stat(toPath);
          wouldOverwrite = true;
        } catch (error) {
          const nodeError = error as NodeJS.ErrnoException;
          if (nodeError.code !== "ENOENT") throw error;
        }
        requireConfirmedExecution(dryRun, confirm);
        if (dryRun) {
          return jsonText({
            backupIds: [],
            bytesCopied: sourceStats.size,
            confirmed: confirm,
            dryRun: true,
            from: fromPath,
            to: toPath,
            wouldOverwrite,
          });
        }
        if (wouldOverwrite && !overwrite) {
          throw new Error(`Destination already exists: ${toPath}`);
        }
        const parentDirectories = await missingParentDirectories(toPath);
        const parentEffects = parentDirectories.map((directoryPath) => ({
          operation: "mkdir" as const,
          path: directoryPath,
        }));
        const backupRecords: BackupRecord[] = [];
        await runJournaledMutation({
          afterSnapshot: async () => [...parentEffects, await pathEffect(fromPath, "copy"), await pathEffect(toPath, "copy")],
          argsRedacted: redactArgs({ confirm, cwd, dryRun, from, overwrite, to }),
          beforeSnapshot: async () => [...parentEffects, await pathEffect(fromPath, "copy"), await pathEffect(toPath, "copy")],
          cwd: resolvedCwd,
          effect: async () => {
            if (parentDirectories.length) {
              await fs.mkdir(path.dirname(toPath), { recursive: true });
            }
            if (wouldOverwrite) {
              backupRecords.push(await createFileBackup(runtime.config, toPath, "copy"));
              assertBackupsRestorable(backupRecords, { allowMissing: false });
            }
            await atomicCopyFile(fromPath, toPath);
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          outcomeDetails: () => ({ backupIds: restorableBackupIds(backupRecords) }),
          requiredScope: SCOPES.write,
          requestId: runtime.context.requestId,
          tool: "copy",
        });
        return jsonText({
          backupIds: restorableBackupIds(backupRecords),
          bytesCopied: sourceStats.size,
          confirmed: confirm,
          dryRun: false,
          from: fromPath,
          to: toPath,
          wouldOverwrite,
        });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerSearchTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "search",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description: "Preferred tool for bounded text search under a directory. Use this instead of shell grep, rg, or Select-String when practical so secret guards and search limits apply.",
      inputSchema: {
        cwd: z.string().optional().describe("Base directory for relative path resolution."),
        includeHidden: z.boolean().optional().default(false),
        maxFiles: z.number().int().positive().max(10_000).optional().default(SEARCH_DEFAULT_MAX_FILES),
        maxMatches: z.number().int().positive().max(2_000).optional().default(SEARCH_DEFAULT_MAX_MATCHES),
        path: z.string().optional().default(".").describe("Directory to search."),
        pattern: z.string().min(1).describe("Pattern to search for."),
        regex: z.boolean().optional().default(false),
      },
      outputSchema: {
        filesScanned: z.number(),
        instructionSafety: z.string(),
        matches: z.array(
          z.object({
            line: z.number(),
            path: z.string(),
            preview: z.string(),
          }),
        ),
        skippedSecretFiles: z.number(),
        sourceTrust: z.enum(["mixed_content"]),
        truncated: z.boolean(),
      },
      title: "Search Files",
    },
    async ({ cwd, includeHidden, maxFiles, maxMatches, path: inputPath, pattern, regex }) => {
      const startedAt = Date.now();
      let resolvedCwd = cwd || runtime.config.defaultCwd;
      try {
        requireScope(runtime.context, SCOPES.read);
        resolvedCwd = await resolveCwd(resolvedCwd);
        const root = resolveFromCwd(resolvedCwd, inputPath);
        assertPolicyModeAllowed(runtime.config, "diagnose");
        await assertPathTargetAllowed(runtime.config, root, "diagnose", { checkSecret: true });
        if (regex) {
          assertSafeSearchRegex(pattern);
        }
        const matcher = regex ? new RegExp(pattern, "gim") : undefined;
        const matches: Array<{ line: number; path: string; preview: string }> = [];
        let filesScanned = 0;
        let skippedSecretFiles = 0;
        let truncated = false;
        for await (const filePath of walkFiles(runtime, root, includeHidden)) {
          if (filesScanned >= maxFiles || matches.length >= maxMatches) {
            truncated = true;
            break;
          }
          if (shouldSkipSensitivePath(runtime, filePath)) {
            skippedSecretFiles += 1;
            continue;
          }
          await assertPathTargetAllowed(runtime.config, filePath, "diagnose", { checkSecret: true });
          filesScanned += 1;
          const stats = await fs.stat(filePath);
          if (stats.size > SEARCH_MAX_FILE_BYTES) continue;
          const content = await fs.readFile(filePath, "utf8").catch(() => "");
          if (!content) continue;
          if (matcher) {
            matcher.lastIndex = 0;
            for (const match of content.matchAll(matcher)) {
              const index = match.index ?? 0;
              const lineStart = content.lastIndexOf("\n", index) + 1;
              const lineEnd = content.indexOf("\n", index);
              matches.push({
                line: lineNumberAt(content, index),
                path: filePath,
                preview: content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
              });
              if (matches.length >= maxMatches) break;
            }
          } else {
            let index = content.indexOf(pattern);
            while (index !== -1 && matches.length < maxMatches) {
              const lineStart = content.lastIndexOf("\n", index) + 1;
              const lineEnd = content.indexOf("\n", index);
              matches.push({
                line: lineNumberAt(content, index),
                path: filePath,
                preview: content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
              });
              index = content.indexOf(pattern, index + pattern.length);
            }
          }
        }
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, includeHidden, maxFiles, maxMatches, path: inputPath, pattern, regex }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "success",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "search",
        });
        return jsonText({
          filesScanned,
          instructionSafety: INSTRUCTION_SAFETY_NOTE,
          matches,
          skippedSecretFiles,
          sourceTrust: "mixed_content",
          truncated,
        });
      } catch (error) {
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, includeHidden, maxFiles, maxMatches, path: inputPath, pattern, regex }),
          cwd: resolvedCwd,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "search",
        });
        return errorText(error);
      }
    },
  );
}

export function registerApplyPatchTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "apply_patch",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description: "Preferred tool for targeted edits in existing files and multi-file changes represented as a unified diff. Use this instead of shell heredocs, Set-Content, or ad-hoc file rewrite commands when practical; supports dry-run, touched file detection, backups, and journal effects.",
      inputSchema: {
        confirm: z.boolean().optional().default(false),
        cwd: z.string().describe("Required working directory."),
        dryRun: z.boolean().optional().default(true),
        patch: z.string().min(1).describe("Unified diff patch content."),
      },
      outputSchema: {
        auditQuality: z.enum(["granular"]),
        ...backupIdsOutputSchema,
        ...commandResultOutputSchema,
        ...dryRunOutputSchema,
        touchedFiles: z.array(z.string()),
      },
      title: "Apply Patch",
    },
    async ({ confirm, cwd, dryRun, patch }) => {
      try {
        requireScope(runtime.context, SCOPES.patch);
        const resolvedCwd = await resolveCwd(cwd);
        assertPolicyModeAllowed(runtime.config, "destructive");
        await assertPathTargetAllowed(runtime.config, resolvedCwd, "destructive", { checkSecret: true });
        const touchedFiles = touchedFilesFromPatch(patch, resolvedCwd);
        if (!touchedFiles.length) {
          throw new Error("Unable to determine touched files from patch");
        }
        await assertPathTargetsAllowed(runtime.config, touchedFiles, "destructive", { checkSecret: true });
        requireConfirmedExecution(dryRun, confirm);
        if (dryRun) {
          const check = await runCommand(
            "git",
            ["apply", "--check", "--whitespace=nowarn", "-"],
            resolvedCwd,
            patch,
            runtime.config.maxOutputBytes,
            runtime.config.shellTimeoutMs,
          );
          const response = jsonText({ auditQuality: "granular", backupIds: [], confirmed: confirm, dryRun: true, touchedFiles, ...check });
          return commandSucceeded(check) ? response : { ...response, isError: true };
        }
        const backupRecords: BackupRecord[] = [];
        const result = await runJournaledOperation<CommandResult>({
          afterSnapshot: async () => Promise.all(touchedFiles.map((filePath) => pathEffect(filePath, "patch"))),
          argsRedacted: redactArgs({ confirm, cwd, dryRun, patch }),
          beforeSnapshot: async () => Promise.all(touchedFiles.map((filePath) => pathEffect(filePath, "patch"))),
          cwd: resolvedCwd,
          effect: async () => {
            for (const filePath of touchedFiles) {
              backupRecords.push(await createFileBackup(runtime.config, filePath, "apply_patch"));
            }
            assertBackupsRestorable(backupRecords, { allowMissing: true });
            return runCommand(
              "git",
              ["apply", "--whitespace=nowarn", "-"],
              resolvedCwd,
              patch,
              runtime.config.maxOutputBytes,
              runtime.config.shellTimeoutMs,
            );
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          outcomeDetails: () => ({ backupIds: restorableBackupIds(backupRecords) }),
          outcomeFromResult: (command) => ({ exitCode: command.code, outcome: commandSucceeded(command) ? "success" : "error" }),
          requiredScope: SCOPES.patch,
          requestId: runtime.context.requestId,
          tool: "apply_patch",
        });
        const response = jsonText({
          backupIds: restorableBackupIds(backupRecords),
          auditQuality: "granular",
          confirmed: confirm,
          dryRun: false,
          touchedFiles,
          ...result,
        });
        return commandSucceeded(result) ? response : { ...response, isError: true };
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerRollbackBackupTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "rollback_backup",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description: "Restore a file from a local backup created by a destructive tool.",
      inputSchema: {
        backupId: z.string().uuid().describe("Backup id returned by a previous tool call."),
        confirm: z.boolean().optional().default(false),
        destinationPath: z.string().optional().describe("Optional absolute restore destination. Defaults to original path."),
        dryRun: z.boolean().optional().default(true),
        overwrite: z.boolean().optional().default(false),
      },
      outputSchema: {
        ...backupIdsOutputSchema,
        ...dryRunOutputSchema,
        backupId: z.string(),
        destinationPath: z.string(),
        originalPath: z.string(),
        restored: z.boolean(),
      },
      title: "Rollback Backup",
    },
    async ({ backupId, confirm, destinationPath, dryRun, overwrite }) => {
      try {
        requireScope(runtime.context, SCOPES.write);
        assertPolicyModeAllowed(runtime.config, "destructive");
        if (destinationPath && !path.isAbsolute(destinationPath)) {
          throw new Error("destinationPath must be absolute when provided");
        }
        const record = await readBackupRecord(runtime.config, backupId);
        if (record.skipped) {
          throw new Error(`Backup ${backupId} is not restorable: ${record.reason || "skipped"}`);
        }
        const targetPath = path.resolve(destinationPath || record.originalPath);
        await assertPathTargetAllowed(runtime.config, targetPath, "destructive", { checkSecret: true });
        requireConfirmedExecution(dryRun, confirm);
        if (dryRun) {
          return jsonText({
            backupId,
            backupIds: [],
            confirmed: confirm,
            destinationPath: targetPath,
            dryRun: true,
            originalPath: record.originalPath,
            restored: false,
          });
        }

        const backupRecords: BackupRecord[] = [];
        await runJournaledMutation({
          afterSnapshot: async () => [await pathEffect(targetPath, "write")],
          argsRedacted: redactArgs({ backupId, confirm, destinationPath, dryRun, overwrite }),
          beforeSnapshot: async () => [await pathEffect(targetPath, "write")],
          cwd: path.dirname(targetPath),
          effect: async () => {
            try {
              await fs.stat(targetPath);
              if (!overwrite) {
                throw new Error(`Destination already exists: ${targetPath}`);
              }
              backupRecords.push(await createFileBackup(runtime.config, targetPath, "rollback_backup"));
              assertBackupsRestorable([backupRecords[backupRecords.length - 1]], { allowMissing: false });
            } catch (error) {
              const nodeError = error as NodeJS.ErrnoException;
              if (nodeError.code !== "ENOENT") {
                throw error;
              }
            }
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.copyFile(record.backupPath, targetPath);
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          outcomeDetails: () => ({ backupIds: restorableBackupIds(backupRecords) }),
          requiredScope: SCOPES.write,
          requestId: runtime.context.requestId,
          tool: "rollback_backup",
        });

        return jsonText({
          backupId,
          backupIds: restorableBackupIds(backupRecords),
          confirmed: confirm,
          destinationPath: targetPath,
          dryRun: false,
          originalPath: record.originalPath,
          restored: true,
        });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerGitStatusTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "git_status",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description: "Preferred tool for repository status. Use this instead of shell git status when practical.",
      inputSchema: { cwd: z.string().describe("Repository working directory.") },
      outputSchema: {
        cwd: z.string(),
        ...commandResultOutputSchema,
      },
      title: "Git Status",
    },
    async ({ cwd }) => {
      try {
        requireScope(runtime.context, SCOPES.git);
        const resolvedCwd = await resolveCwd(cwd);
        assertPolicyModeAllowed(runtime.config, "observe");
        await assertPathTargetAllowed(runtime.config, resolvedCwd, "observe", { checkSecret: true });
        const result = await runCommand(
          "git",
          ["status", "--short", "--branch"],
          resolvedCwd,
          undefined,
          runtime.config.maxOutputBytes,
          runtime.config.shellTimeoutMs,
        );
        return jsonText({ cwd: resolvedCwd, ...result });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerGitDiffTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "git_diff",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description: "Preferred tool for repository diffs. Use this instead of shell git diff when practical.",
      inputSchema: {
        cwd: z.string().describe("Repository working directory."),
        staged: z.boolean().optional().default(false),
      },
      outputSchema: {
        cwd: z.string(),
        staged: z.boolean(),
        ...commandResultOutputSchema,
      },
      title: "Git Diff",
    },
    async ({ cwd, staged }) => {
      try {
        requireScope(runtime.context, SCOPES.git);
        const resolvedCwd = await resolveCwd(cwd);
        assertPolicyModeAllowed(runtime.config, "observe");
        await assertPathTargetAllowed(runtime.config, resolvedCwd, "observe", { checkSecret: true });
        const args = staged ? ["diff", "--cached"] : ["diff"];
        const result = await runCommand("git", args, resolvedCwd, undefined, runtime.config.maxOutputBytes, runtime.config.shellTimeoutMs);
        return jsonText({ cwd: resolvedCwd, staged, ...result });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerGitCommitTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "git_commit",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description: "Preferred tool for creating a git commit with dry-run and confirm semantics. Use this instead of shell git commit when practical. By default commits currently staged changes.",
      inputSchema: {
        addAll: z.boolean().optional().default(false),
        allowEmpty: z.boolean().optional().default(false),
        confirm: z.boolean().optional().default(false),
        cwd: z.string().describe("Repository working directory."),
        dryRun: z.boolean().optional().default(true),
        message: z.string().min(1).describe("Commit message."),
      },
      outputSchema: {
        auditQuality: z.enum(["granular"]),
        cwd: z.string(),
        ...dryRunOutputSchema,
        ...commandResultOutputSchema,
      },
      title: "Git Commit",
    },
    async ({ addAll, allowEmpty, confirm, cwd, dryRun, message }) => {
      try {
        requireScope(runtime.context, SCOPES.git);
        const resolvedCwd = await resolveCwd(cwd);
        assertPolicyModeAllowed(runtime.config, "destructive");
        await assertPathTargetAllowed(runtime.config, resolvedCwd, "destructive", { checkSecret: true });
        requireConfirmedExecution(dryRun, confirm);
        if (dryRun) {
          const result = await runCommand(
            "git",
            ["status", "--short"],
            resolvedCwd,
            undefined,
            runtime.config.maxOutputBytes,
            runtime.config.shellTimeoutMs,
          );
          return jsonText({ auditQuality: "granular", confirmed: confirm, cwd: resolvedCwd, dryRun: true, ...result });
        }
        const result = await runJournaledOperation<CommandResult>({
          argsRedacted: redactArgs({ addAll, allowEmpty, confirm, cwd, dryRun, message }),
          cwd: resolvedCwd,
          effect: async () => {
            if (addAll) {
              const add = await runCommand(
                "git",
                ["add", "-A"],
                resolvedCwd,
                undefined,
                runtime.config.maxOutputBytes,
                runtime.config.shellTimeoutMs,
              );
              if (add.code !== 0) return add;
            }
            const args = ["commit", "-m", message];
            if (allowEmpty) args.push("--allow-empty");
            return runCommand("git", args, resolvedCwd, undefined, runtime.config.maxOutputBytes, runtime.config.shellTimeoutMs);
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          outcomeFromResult: (command) => ({ exitCode: command.code, outcome: commandSucceeded(command) ? "success" : "error" }),
          requiredScope: SCOPES.git,
          requestId: runtime.context.requestId,
          tool: "git_commit",
        });
        const response = jsonText({ auditQuality: "granular", confirmed: confirm, cwd: resolvedCwd, dryRun: false, ...result });
        return commandSucceeded(result) ? response : { ...response, isError: true };
      } catch (error) {
        return errorText(error);
      }
    },
  );
}
