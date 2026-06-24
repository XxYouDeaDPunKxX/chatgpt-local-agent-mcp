import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runBoundedCommand } from "../command.js";
import { errorText, jsonText } from "../format.js";
import { redactArgs, runJournaledOperation } from "../journal.js";
import { McpRuntime } from "../mcp.js";
import { requireScope } from "../runtime.js";
import { SCOPES } from "../scopes.js";

type DesktopBounds = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type DesktopPoint = {
  x: number;
  y: number;
};

type ActiveWindow = {
  bounds?: DesktopBounds;
  handle: string;
  pid: number;
  processName: string;
  title: string;
};

type DesktopState = {
  activeWindow?: ActiveWindow;
  mousePosition: DesktopPoint;
  primaryBounds: DesktopBounds;
  virtualBounds: DesktopBounds;
};

type DesktopGuardInput = {
  expectedProcessName?: string;
  expectedScreenHeight?: number;
  expectedScreenWidth?: number;
  expectedWindowTitle?: string;
};

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function powershellArgs(script: string): string[] {
  return ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script];
}

async function runDesktopPowerShell(runtime: McpRuntime, script: string): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Desktop tools require Windows");
  }
  const result = await runBoundedCommand({
    args: powershellArgs(script),
    cwd: process.cwd(),
    executable: "powershell.exe",
    maxOutputBytes: runtime.config.maxOutputBytes,
    timeoutMs: Math.min(runtime.config.shellTimeoutMs, 30_000),
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "PowerShell desktop command failed");
  }
  return result.stdout.trim();
}

async function runDesktopPowerShellJson<T>(runtime: McpRuntime, script: string): Promise<T> {
  return JSON.parse(await runDesktopPowerShell(runtime, script)) as T;
}

function requireConfirm(confirm: boolean | undefined, tool: string): void {
  if (!confirm) {
    throw new Error(`${tool} requires confirm=true when dryRun=false`);
  }
}

function escapeSendKeysText(value: string): string {
  return value.replace(/([+^%~()[\]{}])/g, "{$1}");
}

function redactedTextLength(value: string): { length: number; redacted: string } {
  return { length: value.length, redacted: "[REDACTED]" };
}

const coordinateSchema = {
  x: z.number().int().min(-100_000).max(100_000),
  y: z.number().int().min(-100_000).max(100_000),
};

const dryRunSchema = {
  confirm: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(true),
};

const desktopGuardSchema = {
  expectedProcessName: z.string().min(1).max(260).optional(),
  expectedScreenHeight: z.number().int().positive().max(100_000).optional(),
  expectedScreenWidth: z.number().int().positive().max(100_000).optional(),
  expectedWindowTitle: z.string().min(1).max(1000).optional(),
};

const desktopActionContextSchema = {
  expectedAction: z.string().min(1).max(1000).describe("Expected UI effect of this desktop action."),
  purpose: z.string().min(1).max(1000).describe("Short operational purpose for using desktop UI fallback."),
};

const boundsOutputSchema = z.object({
  height: z.number(),
  width: z.number(),
  x: z.number(),
  y: z.number(),
});

const activeWindowOutputSchema = z
  .object({
    bounds: boundsOutputSchema.optional(),
    handle: z.string(),
    pid: z.number(),
    processName: z.string(),
    title: z.string(),
  })
  .optional();

const desktopStateOutputSchema = {
  activeWindow: activeWindowOutputSchema,
  mousePosition: z.object({ x: z.number(), y: z.number() }),
  primaryBounds: boundsOutputSchema,
  virtualBounds: boundsOutputSchema,
};

async function getDesktopState(runtime: McpRuntime): Promise<DesktopState> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DesktopInputWindow {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@
function BoundsObject($bounds) {
  [ordered]@{ x = [int]$bounds.X; y = [int]$bounds.Y; width = [int]$bounds.Width; height = [int]$bounds.Height }
}
$virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
$primary = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$cursor = [System.Windows.Forms.Cursor]::Position
$handle = [DesktopInputWindow]::GetForegroundWindow()
$active = $null
if ($handle -ne [IntPtr]::Zero) {
  [uint32]$activeProcessId = 0
  [void][DesktopInputWindow]::GetWindowThreadProcessId($handle, [ref]$activeProcessId)
  $process = $null
  if ($activeProcessId -gt 0) { $process = Get-Process -Id ([int]$activeProcessId) -ErrorAction SilentlyContinue }
  $entry = [ordered]@{
    handle = [string]$handle
    pid = [int]$activeProcessId
    processName = if ($process) { [string]$process.ProcessName } else { "" }
    title = if ($process) { [string]$process.MainWindowTitle } else { "" }
  }
  $rect = New-Object DesktopInputWindow+RECT
  if ([DesktopInputWindow]::GetWindowRect($handle, [ref]$rect)) {
    $entry.bounds = [ordered]@{
      x = [int]$rect.Left
      y = [int]$rect.Top
      width = [int]($rect.Right - $rect.Left)
      height = [int]($rect.Bottom - $rect.Top)
    }
  }
  $active = [pscustomobject]$entry
}
([ordered]@{
  activeWindow = $active
  mousePosition = [ordered]@{ x = [int]$cursor.X; y = [int]$cursor.Y }
  primaryBounds = BoundsObject $primary
  virtualBounds = BoundsObject $virtual
}) | ConvertTo-Json -Depth 8 -Compress
`;
  return runDesktopPowerShellJson<DesktopState>(runtime, script);
}

function pointInsideBounds(point: DesktopPoint, bounds: DesktopBounds): boolean {
  return point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height;
}

function validateExpectedScreen(state: DesktopState, input: DesktopGuardInput): void {
  if (input.expectedScreenWidth !== undefined && input.expectedScreenWidth !== state.virtualBounds.width) {
    throw new Error(`Desktop width changed: expected ${input.expectedScreenWidth}, got ${state.virtualBounds.width}`);
  }
  if (input.expectedScreenHeight !== undefined && input.expectedScreenHeight !== state.virtualBounds.height) {
    throw new Error(`Desktop height changed: expected ${input.expectedScreenHeight}, got ${state.virtualBounds.height}`);
  }
}

function validateExpectedWindow(state: DesktopState, input: DesktopGuardInput): void {
  if (!input.expectedProcessName && !input.expectedWindowTitle) {
    return;
  }
  const active = state.activeWindow;
  if (!active) {
    throw new Error("No active window found for expected window guard");
  }
  if (input.expectedProcessName && active.processName.toLowerCase() !== input.expectedProcessName.toLowerCase()) {
    throw new Error(`Active process mismatch: expected ${input.expectedProcessName}, got ${active.processName}`);
  }
  if (input.expectedWindowTitle && !active.title.toLowerCase().includes(input.expectedWindowTitle.toLowerCase())) {
    throw new Error("Active window title mismatch");
  }
}

function validateCoordinate(state: DesktopState, point: DesktopPoint): void {
  if (!pointInsideBounds(point, state.virtualBounds)) {
    throw new Error(`Desktop coordinate outside virtual screen bounds: ${point.x},${point.y}`);
  }
}

async function validateDesktopAction(runtime: McpRuntime, point: DesktopPoint | undefined, input: DesktopGuardInput): Promise<DesktopState> {
  const state = await getDesktopState(runtime);
  validateExpectedScreen(state, input);
  validateExpectedWindow(state, input);
  if (point) {
    validateCoordinate(state, point);
  }
  return state;
}

function dryRunResult(data: Record<string, unknown>, state: DesktopState): Record<string, unknown> {
  return {
    ...data,
    activeWindow: state.activeWindow,
    dryRun: true,
    mousePosition: state.mousePosition,
    primaryBounds: state.primaryBounds,
    virtualBounds: state.virtualBounds,
    wouldExecute: true,
  };
}

function sendKeysToken(key: string): string {
  const normalized = key.trim();
  if (!/^[A-Za-z0-9]+$/.test(normalized)) {
    throw new Error("desktop_hotkey keys must be alphanumeric key names");
  }
  const upper = normalized.toUpperCase();
  const named: Record<string, string> = {
    BACKSPACE: "{BACKSPACE}",
    DELETE: "{DELETE}",
    DOWN: "{DOWN}",
    END: "{END}",
    ENTER: "{ENTER}",
    ESC: "{ESC}",
    ESCAPE: "{ESC}",
    HOME: "{HOME}",
    INSERT: "{INSERT}",
    LEFT: "{LEFT}",
    PAGEDOWN: "{PGDN}",
    PAGEUP: "{PGUP}",
    RIGHT: "{RIGHT}",
    SPACE: " ",
    TAB: "{TAB}",
    UP: "{UP}",
  };
  if (/^F([1-9]|1[0-2])$/.test(upper)) return `{${upper}}`;
  if (named[upper]) return named[upper];
  if (upper.length === 1) return upper.toLowerCase();
  throw new Error(`Unsupported hotkey key: ${key}`);
}

function hotkeySendKeys(keys: string[]): string {
  if (keys.length < 2) {
    throw new Error("desktop_hotkey requires at least one modifier and one key");
  }
  const modifiers = keys.slice(0, -1).map((key) => key.toUpperCase());
  const key = sendKeysToken(keys[keys.length - 1]);
  let prefix = "";
  for (const modifier of modifiers) {
    if (modifier === "CTRL" || modifier === "CONTROL") prefix += "^";
    else if (modifier === "ALT") prefix += "%";
    else if (modifier === "SHIFT") prefix += "+";
    else throw new Error(`Unsupported hotkey modifier: ${modifier}`);
  }
  return `${prefix}${key}`;
}

export function registerDesktopMousePositionTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "desktop_mouse_position",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
      description: "Return current Windows desktop mouse position, screen bounds, and active window.",
      inputSchema: {},
      outputSchema: desktopStateOutputSchema,
      title: "Get Desktop Mouse Position",
    },
    async () => {
      try {
        requireScope(runtime.context, SCOPES.desktop);
        return jsonText(await getDesktopState(runtime));
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerDesktopMouseMoveTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "desktop_mouse_move",
    {
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
      description:
        "Fallback tool for coordinate-level desktop UI control when browser/CDP/structured tools cannot act. Move the Windows desktop mouse cursor to absolute screen coordinates. Defaults to dryRun=true.",
      inputSchema: { ...coordinateSchema, ...desktopActionContextSchema, ...desktopGuardSchema, ...dryRunSchema },
      outputSchema: {
        ...desktopStateOutputSchema,
        auditQuality: z.enum(["desktop-fallback"]),
        dryRun: z.boolean(),
        expectedAction: z.string(),
        moved: z.boolean(),
        purpose: z.string(),
        target: z.object({ x: z.number(), y: z.number() }),
        wouldExecute: z.boolean(),
      },
      title: "Move Desktop Mouse",
    },
    async ({ confirm, dryRun, expectedAction, expectedProcessName, expectedScreenHeight, expectedScreenWidth, expectedWindowTitle, purpose, x, y }) => {
      try {
        requireScope(runtime.context, SCOPES.desktop);
        const point = { x, y };
        const guard = { expectedProcessName, expectedScreenHeight, expectedScreenWidth, expectedWindowTitle };
        const state = await validateDesktopAction(runtime, point, guard);
        if (dryRun) {
          return jsonText({ auditQuality: "desktop-fallback", expectedAction, moved: false, purpose, target: point, ...dryRunResult({}, state) });
        }
        requireConfirm(confirm, "desktop_mouse_move");
        await runJournaledOperation({
          argsRedacted: redactArgs({ confirm, dryRun, expectedAction, purpose, ...guard, x, y }),
          effect: () =>
            runDesktopPowerShell(
              runtime,
              `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`,
            ),
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.desktop,
          requestId: runtime.context.requestId,
          tool: "desktop_mouse_move",
        });
        return jsonText({ auditQuality: "desktop-fallback", dryRun: false, expectedAction, moved: true, purpose, target: point, wouldExecute: false });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerDesktopMouseClickTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "desktop_mouse_click",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
      description:
        "Fallback tool for coordinate-level desktop UI control when browser/CDP/structured tools cannot act. Move and click the Windows desktop mouse at absolute screen coordinates. Defaults to dryRun=true.",
      inputSchema: {
        button: z.enum(["left", "right", "middle"]).optional().default("left"),
        clickCount: z.number().int().min(1).max(3).optional().default(1),
        ...coordinateSchema,
        ...desktopActionContextSchema,
        ...desktopGuardSchema,
        ...dryRunSchema,
      },
      outputSchema: {
        ...desktopStateOutputSchema,
        auditQuality: z.enum(["desktop-fallback"]),
        button: z.string(),
        clicked: z.boolean(),
        clickCount: z.number(),
        dryRun: z.boolean(),
        expectedAction: z.string(),
        purpose: z.string(),
        target: z.object({ x: z.number(), y: z.number() }),
        wouldExecute: z.boolean(),
      },
      title: "Click Desktop Mouse",
    },
    async ({ button, clickCount, confirm, dryRun, expectedAction, expectedProcessName, expectedScreenHeight, expectedScreenWidth, expectedWindowTitle, purpose, x, y }) => {
      try {
        requireScope(runtime.context, SCOPES.desktop);
        const point = { x, y };
        const guard = { expectedProcessName, expectedScreenHeight, expectedScreenWidth, expectedWindowTitle };
        const state = await validateDesktopAction(runtime, point, guard);
        if (dryRun) {
          return jsonText({ auditQuality: "desktop-fallback", button, clicked: false, clickCount, expectedAction, purpose, target: point, ...dryRunResult({}, state) });
        }
        requireConfirm(confirm, "desktop_mouse_click");
        const eventNames =
          button === "right"
            ? ["RIGHTDOWN", "RIGHTUP"]
            : button === "middle"
              ? ["MIDDLEDOWN", "MIDDLEUP"]
              : ["LEFTDOWN", "LEFTUP"];
        const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DesktopInputMouse {
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
$flags = @{
  LEFTDOWN = 0x0002
  LEFTUP = 0x0004
  RIGHTDOWN = 0x0008
  RIGHTUP = 0x0010
  MIDDLEDOWN = 0x0020
  MIDDLEUP = 0x0040
}
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
for ($i = 0; $i -lt ${clickCount}; $i++) {
  [DesktopInputMouse]::mouse_event($flags.${eventNames[0]}, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
  [DesktopInputMouse]::mouse_event($flags.${eventNames[1]}, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
}
`;
        await runJournaledOperation({
          argsRedacted: redactArgs({ button, clickCount, confirm, dryRun, expectedAction, purpose, ...guard, x, y }),
          effect: () => runDesktopPowerShell(runtime, script),
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.desktop,
          requestId: runtime.context.requestId,
          tool: "desktop_mouse_click",
        });
        return jsonText({ auditQuality: "desktop-fallback", button, clicked: true, clickCount, dryRun: false, expectedAction, purpose, target: point, wouldExecute: false });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerDesktopKeyPressTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "desktop_key_press",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
      description:
        "Fallback tool for active-window keyboard control when browser/CDP/structured tools cannot act. Send a SendKeys key string to the active Windows desktop application. Defaults to dryRun=true.",
      inputSchema: { confirm: z.boolean().optional().default(false), dryRun: z.boolean().optional().default(true), key: z.string().min(1).max(80), ...desktopActionContextSchema, ...desktopGuardSchema },
      outputSchema: {
        ...desktopStateOutputSchema,
        auditQuality: z.enum(["desktop-fallback"]),
        dryRun: z.boolean(),
        expectedAction: z.string(),
        keyLength: z.number(),
        pressed: z.boolean(),
        purpose: z.string(),
        wouldExecute: z.boolean(),
      },
      title: "Press Desktop Key",
    },
    async ({ confirm, dryRun, expectedAction, expectedProcessName, expectedScreenHeight, expectedScreenWidth, expectedWindowTitle, key, purpose }) => {
      try {
        requireScope(runtime.context, SCOPES.desktop);
        const guard = { expectedProcessName, expectedScreenHeight, expectedScreenWidth, expectedWindowTitle };
        const state = await validateDesktopAction(runtime, undefined, guard);
        if (dryRun) {
          return jsonText({ auditQuality: "desktop-fallback", expectedAction, keyLength: key.length, pressed: false, purpose, ...dryRunResult({}, state) });
        }
        requireConfirm(confirm, "desktop_key_press");
        await runJournaledOperation({
          argsRedacted: redactArgs({ confirm, dryRun, expectedAction, key: redactedTextLength(key), purpose, ...guard }),
          effect: () =>
            runDesktopPowerShell(
              runtime,
              `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psString(key)})`,
            ),
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.desktop,
          requestId: runtime.context.requestId,
          tool: "desktop_key_press",
        });
        return jsonText({ auditQuality: "desktop-fallback", dryRun: false, expectedAction, keyLength: key.length, pressed: true, purpose, wouldExecute: false });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerDesktopHotkeyTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "desktop_hotkey",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
      description:
        "Fallback tool for active-window hotkeys when browser/CDP/structured tools cannot act. Send a structured hotkey to the active Windows desktop application, e.g. CTRL+L. Defaults to dryRun=true.",
      inputSchema: { confirm: z.boolean().optional().default(false), dryRun: z.boolean().optional().default(true), keys: z.array(z.string().min(1).max(32)).min(2).max(4), ...desktopActionContextSchema, ...desktopGuardSchema },
      outputSchema: {
        ...desktopStateOutputSchema,
        auditQuality: z.enum(["desktop-fallback"]),
        dryRun: z.boolean(),
        expectedAction: z.string(),
        keyCount: z.number(),
        pressed: z.boolean(),
        purpose: z.string(),
        wouldExecute: z.boolean(),
      },
      title: "Press Desktop Hotkey",
    },
    async ({ confirm, dryRun, expectedAction, expectedProcessName, expectedScreenHeight, expectedScreenWidth, expectedWindowTitle, keys, purpose }) => {
      try {
        requireScope(runtime.context, SCOPES.desktop);
        const sendKeys = hotkeySendKeys(keys);
        const guard = { expectedProcessName, expectedScreenHeight, expectedScreenWidth, expectedWindowTitle };
        const state = await validateDesktopAction(runtime, undefined, guard);
        if (dryRun) {
          return jsonText({ auditQuality: "desktop-fallback", expectedAction, keyCount: keys.length, pressed: false, purpose, ...dryRunResult({}, state) });
        }
        requireConfirm(confirm, "desktop_hotkey");
        await runJournaledOperation({
          argsRedacted: redactArgs({ confirm, dryRun, expectedAction, keyCount: keys.length, keys, purpose, ...guard }),
          effect: () =>
            runDesktopPowerShell(
              runtime,
              `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psString(sendKeys)})`,
            ),
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.desktop,
          requestId: runtime.context.requestId,
          tool: "desktop_hotkey",
        });
        return jsonText({ auditQuality: "desktop-fallback", dryRun: false, expectedAction, keyCount: keys.length, pressed: true, purpose, wouldExecute: false });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerDesktopTextTypeTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "desktop_text_type",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
      description:
        "Fallback tool for active-window text entry when browser/CDP/structured tools cannot act. Type text into the active Windows desktop application. Defaults to dryRun=true. Journal redacts text content.",
      inputSchema: { confirm: z.boolean().optional().default(false), dryRun: z.boolean().optional().default(true), text: z.string().min(1).max(10_000), ...desktopActionContextSchema, ...desktopGuardSchema },
      outputSchema: {
        ...desktopStateOutputSchema,
        auditQuality: z.enum(["desktop-fallback"]),
        dryRun: z.boolean(),
        expectedAction: z.string(),
        length: z.number(),
        purpose: z.string(),
        typed: z.boolean(),
        wouldExecute: z.boolean(),
      },
      title: "Type Desktop Text",
    },
    async ({ confirm, dryRun, expectedAction, expectedProcessName, expectedScreenHeight, expectedScreenWidth, expectedWindowTitle, purpose, text }) => {
      try {
        requireScope(runtime.context, SCOPES.desktop);
        const guard = { expectedProcessName, expectedScreenHeight, expectedScreenWidth, expectedWindowTitle };
        const state = await validateDesktopAction(runtime, undefined, guard);
        if (dryRun) {
          return jsonText({ auditQuality: "desktop-fallback", expectedAction, length: text.length, purpose, typed: false, ...dryRunResult({}, state) });
        }
        requireConfirm(confirm, "desktop_text_type");
        await runJournaledOperation({
          argsRedacted: redactArgs({ confirm, dryRun, expectedAction, purpose, text: redactedTextLength(text), ...guard }),
          effect: () =>
            runDesktopPowerShell(
              runtime,
              `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psString(escapeSendKeysText(text))})`,
            ),
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.desktop,
          requestId: runtime.context.requestId,
          tool: "desktop_text_type",
        });
        return jsonText({ auditQuality: "desktop-fallback", dryRun: false, expectedAction, length: text.length, purpose, typed: true, wouldExecute: false });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}
