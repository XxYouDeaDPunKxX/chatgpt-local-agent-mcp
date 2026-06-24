import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runBoundedCommand } from "../command.js";
import { errorText, jsonText } from "../format.js";
import { FileEffect, redactArgs, runJournaledOperation, sha256Hex } from "../journal.js";
import { McpRuntime } from "../mcp.js";
import { requireScope } from "../runtime.js";
import { SCOPES } from "../scopes.js";
import { INSTRUCTION_SAFETY_NOTE } from "../source-trust.js";

function screenDataDir(runtime: McpRuntime): string {
  return path.join(path.dirname(runtime.config.journalPath), "screenshots");
}

type ScreenBounds = {
  height: number;
  width: number;
  x: number;
  y: number;
};

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function powershellArgs(script: string): string[] {
  return ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script];
}

async function runPowerShellJson<T>(runtime: McpRuntime, script: string): Promise<T> {
  if (process.platform !== "win32") {
    throw new Error("Screen tools require Windows");
  }
  const result = await runBoundedCommand({
    args: powershellArgs(script),
    cwd: process.cwd(),
    executable: "powershell.exe",
    maxOutputBytes: runtime.config.maxOutputBytes,
    timeoutMs: Math.min(runtime.config.shellTimeoutMs, 30_000),
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "PowerShell screen command failed");
  }
  return JSON.parse(result.stdout.trim()) as T;
}

async function imageMetadata(filePath: string): Promise<{ hash: string; path: string; size: number }> {
  const content = await fs.readFile(filePath);
  return {
    hash: sha256Hex(content),
    path: filePath,
    size: content.byteLength,
  };
}

function validateScreenshotBounds(runtime: McpRuntime, bounds: Pick<ScreenBounds, "height" | "width">): void {
  if (bounds.width > runtime.config.maxScreenshotDimension || bounds.height > runtime.config.maxScreenshotDimension) {
    throw new Error(
      `Screenshot dimension too large: ${bounds.width}x${bounds.height} > ${runtime.config.maxScreenshotDimension}`,
    );
  }
  const area = bounds.width * bounds.height;
  if (area > runtime.config.maxScreenshotAreaPixels) {
    throw new Error(`Screenshot area too large: ${area} pixels > ${runtime.config.maxScreenshotAreaPixels}`);
  }
}

function encodedBase64Bytes(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

function redactOcrText(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(
      /(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Z0-9_]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&"'`]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/((?:api[_-]?key|client[_-]?secret|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&"'`]+)/gi, "$1[REDACTED]");
}

function redactWindowTitle(title: string): string {
  if (!title) return title;
  return redactOcrText(title)
    .replace(/\b[A-Z]:\\[^\r\n\t]+/gi, "[REDACTED_PATH]")
    .replace(/\b(?:https?:\/\/|file:\/\/)[^\s]+/gi, "[REDACTED_URL]");
}

async function cleanupScreenshots(
  runtime: McpRuntime,
  preservePath?: string,
): Promise<{ deleted: number; deletedBytes: number; deletedFiles: Array<{ path: string; size: number }> }> {
  const directory = screenDataDir(runtime);
  await fs.mkdir(directory, { recursive: true });
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
        .map(async (entry) => {
          const filePath = path.join(directory, entry.name);
          const stats = await fs.stat(filePath);
          return { filePath, mtimeMs: stats.mtimeMs, size: stats.size };
        }),
    )
  ).sort((a, b) => b.mtimeMs - a.mtimeMs);

  const preserved = preservePath ? path.resolve(preservePath) : undefined;
  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  let keptFiles = 0;
  let deleted = 0;
  let deletedBytes = 0;
  const deletedFiles: Array<{ path: string; size: number }> = [];

  for (const file of files) {
    const isPreserved = preserved && path.resolve(file.filePath) === preserved;
    const exceedsFileCount = keptFiles >= runtime.config.maxScreenshotFiles;
    const exceedsByteBudget = totalBytes > runtime.config.maxScreenshotBytes;
    if (!isPreserved && (exceedsFileCount || exceedsByteBudget)) {
      await fs.rm(file.filePath, { force: true });
      totalBytes -= file.size;
      deleted += 1;
      deletedBytes += file.size;
      deletedFiles.push({ path: file.filePath, size: file.size });
      continue;
    }
    keptFiles += 1;
  }

  return { deleted, deletedBytes, deletedFiles };
}

export function registerWindowListTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "window_list",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Preferred desktop-observation tool before coordinate fallback actions. List visible top-level desktop windows on the local Windows session. Window titles are redacted by default.",
      inputSchema: {
        confirm: z.boolean().optional().default(false),
        includeBounds: z.boolean().optional().default(true),
        maxWindows: z.number().int().positive().max(500).optional().default(100),
        raw: z.boolean().optional().default(false),
      },
      outputSchema: {
        platform: z.string(),
        raw: z.boolean(),
        redacted: z.boolean(),
        truncated: z.boolean(),
        windows: z.array(
          z.object({
            bounds: z
              .object({
                height: z.number(),
                width: z.number(),
                x: z.number(),
                y: z.number(),
              })
              .optional(),
            handle: z.string(),
            pid: z.number(),
            processName: z.string(),
            title: z.string(),
          }),
        ),
      },
      title: "List Desktop Windows",
    },
    async ({ confirm, includeBounds, maxWindows, raw }) => {
      const startedAt = Date.now();
      try {
        requireScope(runtime.context, SCOPES.screen);
        if (raw && !confirm) {
          throw new Error("window_list raw titles require confirm=true");
        }
        const script = `
$ErrorActionPreference = 'Stop'
$includeBounds = ${includeBounds ? "$true" : "$false"}
$maxWindows = ${maxWindows}
if ($includeBounds) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32WindowBounds {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@
}
$items = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Sort-Object ProcessName, Id
$truncated = $items.Count -gt $maxWindows
$windows = @()
foreach ($process in ($items | Select-Object -First $maxWindows)) {
  $entry = [ordered]@{
    pid = [int]$process.Id
    processName = [string]$process.ProcessName
    title = [string]$process.MainWindowTitle
    handle = [string]$process.MainWindowHandle
  }
  if ($includeBounds) {
    $rect = New-Object Win32WindowBounds+RECT
    if ([Win32WindowBounds]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) {
      $entry.bounds = [ordered]@{
        x = [int]$rect.Left
        y = [int]$rect.Top
        width = [int]($rect.Right - $rect.Left)
        height = [int]($rect.Bottom - $rect.Top)
      }
    }
  }
  $windows += [pscustomobject]$entry
}
([ordered]@{ platform = [string][System.Environment]::OSVersion.Platform; truncated = [bool]$truncated; windows = $windows }) | ConvertTo-Json -Depth 8 -Compress
`;
        const result = await runPowerShellJson<{ platform: string; truncated: boolean; windows: Array<Record<string, unknown>> }>(
          runtime,
          script,
        );
        const windows = result.windows.map((window) => ({
          ...window,
          title: raw ? String(window.title || "") : redactWindowTitle(String(window.title || "")),
        }));
        await runtime.journal.append({
          argsRedacted: redactArgs({ confirm, includeBounds, maxWindows, raw }),
          durationMs: Date.now() - startedAt,
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "success",
          requiredScope: SCOPES.screen,
          timestamp: new Date().toISOString(),
          tool: "window_list",
        });
        return jsonText({ ...result, raw, redacted: !raw, windows });
      } catch (error) {
        await runtime.journal.append({
          argsRedacted: redactArgs({ confirm, includeBounds, maxWindows, raw }),
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.screen,
          timestamp: new Date().toISOString(),
          tool: "window_list",
        });
        return errorText(error);
      }
    },
  );
}

export function registerScreenScreenshotTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "screen_screenshot",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Visual fallback for desktop inspection. Capture a PNG screenshot of all screens, the primary screen, or an explicit region; prefer window_list, browser_snapshot, browser_console, or browser_network when structured data is enough.",
      inputSchema: {
        allowFullDesktop: z.boolean().optional().default(false),
        confirm: z.boolean().optional().default(false),
        includeImageBase64: z.boolean().optional().default(false),
        mode: z.enum(["all_screens", "primary", "region"]).optional().default("primary"),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
      },
      outputSchema: {
        auditQuality: z.enum(["visual"]),
        bounds: z.object({
          height: z.number(),
          width: z.number(),
          x: z.number(),
          y: z.number(),
        }),
        cleanup: z.object({
          deleted: z.number(),
          deletedBytes: z.number(),
        }),
        hash: z.string(),
        imageBase64: z.string().optional(),
        instructionSafety: z.string(),
        path: z.string(),
        screenshotId: z.string(),
        size: z.number(),
        sourceTrust: z.enum(["screen_observed_content"]),
      },
      title: "Capture Screen Screenshot",
    },
    async ({ allowFullDesktop, confirm, height, includeImageBase64, mode, width, x, y }) => {
      const startedAt = Date.now();
      const screenshotId = crypto.randomUUID();
      let operationStarted = false;
      try {
        requireScope(runtime.context, SCOPES.screen);
        if (mode === "all_screens" && !allowFullDesktop) {
          throw new Error("allowFullDesktop=true is required when mode=all_screens");
        }
        if (mode === "all_screens" && !confirm) {
          throw new Error("confirm=true is required when mode=all_screens");
        }
        if (mode === "region" && (x === undefined || y === undefined || width === undefined || height === undefined)) {
          throw new Error("x, y, width, and height are required when mode=region");
        }
        if (mode === "region") {
          validateScreenshotBounds(runtime, { height: height || 1, width: width || 1 });
        }
        const directory = screenDataDir(runtime);
        await fs.mkdir(directory, { recursive: true });
        const filePath = path.join(directory, `${screenshotId}.png`);
        const argsRedacted = redactArgs({ allowFullDesktop, confirm, includeImageBase64, mode, x, y, width, height });
        let cleanupEffects: FileEffect[] = [];
        const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$mode = ${psString(mode)}
$filePath = ${psString(filePath)}
$maxDimension = ${runtime.config.maxScreenshotDimension}
$maxAreaPixels = ${runtime.config.maxScreenshotAreaPixels}
if ($mode -eq 'region') {
  $bounds = New-Object System.Drawing.Rectangle(${x || 0}, ${y || 0}, ${width || 1}, ${height || 1})
} elseif ($mode -eq 'primary') {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
} else {
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $left = ($screens | ForEach-Object { $_.Bounds.Left } | Measure-Object -Minimum).Minimum
  $top = ($screens | ForEach-Object { $_.Bounds.Top } | Measure-Object -Minimum).Minimum
  $right = ($screens | ForEach-Object { $_.Bounds.Right } | Measure-Object -Maximum).Maximum
  $bottom = ($screens | ForEach-Object { $_.Bounds.Bottom } | Measure-Object -Maximum).Maximum
  $bounds = New-Object System.Drawing.Rectangle($left, $top, ($right - $left), ($bottom - $top))
}
if ($bounds.Width -gt $maxDimension -or $bounds.Height -gt $maxDimension) {
  throw "Screenshot dimension too large: $($bounds.Width)x$($bounds.Height) > $maxDimension"
}
$area = [int64]$bounds.Width * [int64]$bounds.Height
if ($area -gt $maxAreaPixels) {
  throw "Screenshot area too large: $area pixels > $maxAreaPixels"
}
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save($filePath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
([ordered]@{ bounds = [ordered]@{ x = [int]$bounds.X; y = [int]$bounds.Y; width = [int]$bounds.Width; height = [int]$bounds.Height } }) | ConvertTo-Json -Depth 5 -Compress
`;
        operationStarted = true;
        const result = await runJournaledOperation({
          afterSnapshot: async () => {
            const effects = [...cleanupEffects];
            try {
              const metadata = await imageMetadata(filePath);
              effects.push({
                afterHash: metadata.hash,
                bytesAfter: metadata.size,
                operation: "create",
                path: filePath,
              });
            } catch (error) {
              const nodeError = error as NodeJS.ErrnoException;
              if (nodeError.code !== "ENOENT") throw error;
            }
            return effects;
          },
          argsRedacted,
          beforeSnapshot: async () => [],
          cwd: directory,
          effect: async () => {
            const capture = await runPowerShellJson<{ bounds: ScreenBounds }>(runtime, script);
            validateScreenshotBounds(runtime, capture.bounds);
            const metadata = await imageMetadata(filePath);
            if (metadata.size > runtime.config.maxScreenshotBytes) {
              await fs.rm(filePath, { force: true });
              throw new Error(`Screenshot too large: ${metadata.size} bytes > ${runtime.config.maxScreenshotBytes}`);
            }
            const cleanup = await cleanupScreenshots(runtime, filePath);
            cleanupEffects = cleanup.deletedFiles.map((file) => ({
              bytesBefore: file.size,
              operation: "delete",
              path: file.path,
            }));
            const output: Record<string, unknown> = {
              auditQuality: "visual",
              bounds: capture.bounds,
              cleanup: {
                deleted: cleanup.deleted,
                deletedBytes: cleanup.deletedBytes,
              },
              hash: metadata.hash,
              instructionSafety: INSTRUCTION_SAFETY_NOTE,
              path: metadata.path,
              screenshotId,
              size: metadata.size,
              sourceTrust: "screen_observed_content",
            };
            if (includeImageBase64) {
              const encodedBytes = encodedBase64Bytes(metadata.size);
              if (encodedBytes > runtime.config.maxOutputBytes) {
                throw new Error(`Screenshot too large for base64 output: ${encodedBytes} bytes > ${runtime.config.maxOutputBytes}`);
              }
              output.imageBase64 = (await fs.readFile(filePath)).toString("base64");
            }
            return output;
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.screen,
          requestId: runtime.context.requestId,
          tool: "screen_screenshot",
        });
        return jsonText(result);
      } catch (error) {
        if (!operationStarted) {
          await runtime.journal.append({
            argsRedacted: redactArgs({ allowFullDesktop, confirm, includeImageBase64, mode, x, y, width, height }),
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
            id: runtime.context.requestId,
            identity: runtime.context.identity,
            outcome: "error",
            requiredScope: SCOPES.screen,
            timestamp: new Date().toISOString(),
            tool: "screen_screenshot",
          });
        }
        return errorText(error);
      }
    },
  );
}

export function registerScreenOcrTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "screen_ocr",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Visual text fallback over a screen_screenshot artifact. Prefer browser_snapshot or structured tools when available; OCR is best-effort and requires local tesseract executable.",
      inputSchema: {
        confirm: z.boolean().optional().default(false),
        language: z.string().min(1).max(32).optional().default("eng"),
        psm: z.number().int().min(0).max(13).optional().default(6),
        raw: z.boolean().optional().default(false),
        redact: z.boolean().optional().default(true),
        screenshotId: z.string().uuid(),
      },
      outputSchema: {
        auditQuality: z.enum(["visual"]),
        available: z.boolean(),
        error: z.string().optional(),
        language: z.string(),
        path: z.string(),
        psm: z.number(),
        redacted: z.boolean(),
        instructionSafety: z.string(),
        sourceTrust: z.enum(["screen_observed_content"]),
        stderr: z.string().optional(),
        text: z.string(),
      },
      title: "OCR Screenshot",
    },
    async ({ confirm, language, psm, raw, redact, screenshotId }) => {
      const startedAt = Date.now();
      const filePath = path.join(screenDataDir(runtime), `${screenshotId}.png`);
      try {
        requireScope(runtime.context, SCOPES.screen);
        if ((raw || !redact) && !confirm) {
          throw new Error("confirm=true is required when raw=true or redact=false");
        }
        await fs.access(filePath);
        let result: Record<string, unknown>;
        let ocrAvailable = false;
        try {
          const command = await runBoundedCommand({
            args: [filePath, "stdout", "-l", language, "--psm", String(psm)],
            cwd: process.cwd(),
            executable: "tesseract",
            maxOutputBytes: runtime.config.maxOutputBytes,
            timeoutMs: Math.min(runtime.config.shellTimeoutMs, 60_000),
          });
          const text = raw || !redact ? command.stdout : redactOcrText(command.stdout);
          result = {
            auditQuality: "visual",
            available: true,
            error: command.code === 0 ? undefined : "tesseract exited with a non-zero code",
            instructionSafety: INSTRUCTION_SAFETY_NOTE,
            language,
            path: filePath,
            psm,
            redacted: !raw && redact,
            sourceTrust: "screen_observed_content",
            stderr: command.stderr || undefined,
            text,
          };
          ocrAvailable = command.code === 0;
        } catch (error) {
          result = {
            auditQuality: "visual",
            available: false,
            error: error instanceof Error ? error.message : String(error),
            instructionSafety: INSTRUCTION_SAFETY_NOTE,
            language,
            path: filePath,
            psm,
            redacted: !raw && redact,
            sourceTrust: "screen_observed_content",
            text: "",
          };
        }
        await runtime.journal.append({
          argsRedacted: redactArgs({ confirm, language, psm, raw, redact, screenshotId }),
          durationMs: Date.now() - startedAt,
          error: ocrAvailable ? undefined : String(result.error || "OCR unavailable"),
          effects: [
            {
              operation: "read",
              path: filePath,
            },
          ],
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: ocrAvailable ? "success" : "error",
          requiredScope: SCOPES.screen,
          timestamp: new Date().toISOString(),
          tool: "screen_ocr",
        });
        return jsonText(result);
      } catch (error) {
        await runtime.journal.append({
          argsRedacted: redactArgs({ confirm, language, psm, raw, redact, screenshotId }),
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.screen,
          timestamp: new Date().toISOString(),
          tool: "screen_ocr",
        });
        return errorText(error);
      }
    },
  );
}
