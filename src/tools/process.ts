import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runBoundedCommand, sanitizedRunnerEnv, shellCommandArgs } from "../command.js";
import { assertCommandPolicyAllowed } from "../command-policy.js";
import { errorText, jsonText } from "../format.js";
import { assertPathTargetAllowed, assertPolicyModeAllowed } from "../guards.js";
import { redactArgs, redactShellCommand, runJournaledOperation } from "../journal.js";
import { McpRuntime } from "../mcp.js";
import { resolveCwd, resolveFromCwd, warningsForCommand } from "../paths.js";
import { requireScope } from "../runtime.js";
import { SCOPES } from "../scopes.js";

type ManagedProcess = {
  command: string;
  cwd: string;
  exitCode?: number | null;
  id: string;
  maxLogBytes: number;
  pid: number;
  signal?: NodeJS.Signals | null;
  startedAt: string;
  status: "running" | "exited";
  stderrBytes: number;
  stderrPath: string;
  stderrTruncated: boolean;
  stdoutBytes: number;
  stdoutPath: string;
  stdoutTruncated: boolean;
};

type ProcessInfo = {
  commandLine?: string;
  name: string;
  parentPid?: number;
  pid: number;
};

const managedProcesses = new Map<string, ManagedProcess>();
let managedProcessesHydrated = false;
const MAX_MANAGED_PROCESSES = 100;
const DEFAULT_PROCESS_LOG_BYTES = 1_000_000;
const HARD_PROCESS_LOG_BYTES = 50_000_000;
const CRITICAL_PROCESS_NAMES = new Set(["cloudflared.exe", "cloudflared"]);

const dryRunOutputSchema = {
  confirmed: z.boolean(),
  dryRun: z.boolean(),
};

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

function requireConfirmedExecution(dryRun: boolean, confirm: boolean): void {
  if (!dryRun && !confirm) {
    throw new Error("confirm=true is required when dryRun=false");
  }
}

function processDataDir(runtime: McpRuntime): string {
  return path.join(path.dirname(runtime.config.journalPath), "processes");
}

function processMetadataPath(runtime: McpRuntime, processId: string): string {
  return path.join(processDataDir(runtime), processId, "metadata.json");
}

function parseManagedProcess(value: unknown): ManagedProcess | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.command !== "string" ||
    typeof record.cwd !== "string" ||
    typeof record.id !== "string" ||
    typeof record.maxLogBytes !== "number" ||
    typeof record.pid !== "number" ||
    typeof record.startedAt !== "string" ||
    (record.status !== "running" && record.status !== "exited") ||
    typeof record.stderrBytes !== "number" ||
    typeof record.stderrPath !== "string" ||
    typeof record.stderrTruncated !== "boolean" ||
    typeof record.stdoutBytes !== "number" ||
    typeof record.stdoutPath !== "string" ||
    typeof record.stdoutTruncated !== "boolean"
  ) {
    return undefined;
  }
  return {
    command: record.command,
    cwd: record.cwd,
    exitCode: typeof record.exitCode === "number" || record.exitCode === null ? record.exitCode : undefined,
    id: record.id,
    maxLogBytes: record.maxLogBytes,
    pid: record.pid,
    signal: typeof record.signal === "string" || record.signal === null ? (record.signal as NodeJS.Signals | null) : undefined,
    startedAt: record.startedAt,
    status: record.status,
    stderrBytes: record.stderrBytes,
    stderrPath: record.stderrPath,
    stderrTruncated: record.stderrTruncated,
    stdoutBytes: record.stdoutBytes,
    stdoutPath: record.stdoutPath,
    stdoutTruncated: record.stdoutTruncated,
  };
}

async function writeManagedProcessMetadata(runtime: McpRuntime, record: ManagedProcess): Promise<void> {
  const metadataPath = processMetadataPath(runtime, record.id);
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function hydrateManagedProcesses(runtime: McpRuntime): Promise<void> {
  if (managedProcessesHydrated) return;
  managedProcessesHydrated = true;
  const directory = processDataDir(runtime);
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metadataPath = processMetadataPath(runtime, entry.name);
    try {
      const parsed = JSON.parse(await fs.readFile(metadataPath, "utf8")) as unknown;
      const record = parseManagedProcess(parsed);
      if (!record) continue;
      if (record.status === "running") {
        const processInfo = await getProcessInfo(runtime, record.pid);
        if (!processInfo) {
          record.status = "exited";
          record.exitCode = null;
          await writeManagedProcessMetadata(runtime, record);
        }
      }
      managedProcesses.set(record.id, record);
    } catch {
      continue;
    }
  }
  pruneManagedProcesses();
}

function pruneManagedProcesses(): void {
  while (managedProcesses.size > MAX_MANAGED_PROCESSES) {
    const oldest = managedProcesses.keys().next().value;
    if (!oldest) break;
    managedProcesses.delete(oldest);
  }
}

async function runSystemCommand(runtime: McpRuntime, executable: string, args: string[], timeoutMs?: number) {
  return runBoundedCommand({
    args,
    cwd: process.cwd(),
    executable,
    maxOutputBytes: runtime.config.maxOutputBytes,
    timeoutMs: timeoutMs || Math.min(runtime.config.shellTimeoutMs, 30_000),
  });
}

function psJsonCommand(command: string): { args: string[]; executable: string } {
  return {
    executable: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
  };
}

function parsePowerShellJson<T>(stdout: string, fallback: T[]): T[] {
  if (!stdout.trim()) return fallback;
  const parsed = JSON.parse(stdout) as T | T[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

async function getProcessInfo(runtime: McpRuntime, pid: number): Promise<ProcessInfo | undefined> {
  if (process.platform === "win32") {
    const { args, executable } = psJsonCommand(
      `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`,
    );
    const result = await runSystemCommand(runtime, executable, args, 10_000);
    if (result.code !== 0 || !result.stdout.trim()) return undefined;
    const [item] = parsePowerShellJson<Record<string, unknown>>(result.stdout, []);
    if (!item) return undefined;
    return {
      commandLine: typeof item.CommandLine === "string" ? redactShellCommand(item.CommandLine) : undefined,
      name: String(item.Name || ""),
      parentPid: typeof item.ParentProcessId === "number" ? item.ParentProcessId : undefined,
      pid: Number(item.ProcessId),
    };
  }

  const result = await runSystemCommand(runtime, "ps", ["-p", String(pid), "-o", "pid=,ppid=,comm=,args="], 10_000);
  if (result.code !== 0 || !result.stdout.trim()) return undefined;
  const line = result.stdout.trim().split(/\r?\n/)[0];
  const match = /^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
  if (!match) return undefined;
  return {
    commandLine: redactShellCommand(match[4] || ""),
    name: match[3],
    parentPid: Number.parseInt(match[2], 10),
    pid: Number.parseInt(match[1], 10),
  };
}

function parseNetstat(stdout: string): Array<{
  localAddress: string;
  localPort: number;
  protocol: "tcp" | "udp";
  remoteAddress?: string;
  remotePort?: number;
  state?: string;
  pid: number;
}> {
  const ports = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^(TCP|UDP)\s+/i.test(trimmed)) continue;
    const parts = trimmed.split(/\s+/);
    const protocol = parts[0].toLowerCase() as "tcp" | "udp";
    const local = parts[1];
    const remote = protocol === "tcp" ? parts[2] : undefined;
    const state = protocol === "tcp" ? parts[3] : undefined;
    const pidText = protocol === "tcp" ? parts[4] : parts[parts.length - 1];
    const localEndpoint = splitEndpoint(local);
    const remoteEndpoint = remote ? splitEndpoint(remote) : undefined;
    const pid = Number.parseInt(pidText, 10);
    if (!localEndpoint || !Number.isFinite(pid)) continue;
    ports.push({
      localAddress: localEndpoint.address,
      localPort: localEndpoint.port,
      pid,
      protocol,
      remoteAddress: remoteEndpoint?.address,
      remotePort: remoteEndpoint?.port,
      state,
    });
  }
  return ports;
}

function attachCappedLog(
  stream: NodeJS.ReadableStream,
  filePath: string,
  record: ManagedProcess,
  field: "stdout" | "stderr",
): fsSync.WriteStream {
  const writer = fsSync.createWriteStream(filePath, { flags: "a" });
  const bytesKey = field === "stdout" ? "stdoutBytes" : "stderrBytes";
  const truncatedKey = field === "stdout" ? "stdoutTruncated" : "stderrTruncated";

  stream.on("data", (chunk: Buffer | string) => {
    if (record[truncatedKey]) {
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = record.maxLogBytes - record[bytesKey];
    if (remaining <= 0) {
      record[truncatedKey] = true;
      writer.write("\n[LOG_TRUNCATED]\n");
      return;
    }
    if (buffer.byteLength <= remaining) {
      record[bytesKey] += buffer.byteLength;
      writer.write(buffer);
      return;
    }
    writer.write(buffer.subarray(0, remaining));
    record[bytesKey] += remaining;
    record[truncatedKey] = true;
    writer.write("\n[LOG_TRUNCATED]\n");
  });

  stream.on("end", () => writer.end());
  stream.on("error", () => writer.end());
  return writer;
}

function splitEndpoint(endpoint: string): { address: string; port: number } | undefined {
  const lastColon = endpoint.lastIndexOf(":");
  if (lastColon < 0) return undefined;
  const address = endpoint.slice(0, lastColon).replace(/^\[|\]$/g, "");
  const port = Number.parseInt(endpoint.slice(lastColon + 1), 10);
  if (!Number.isFinite(port)) return undefined;
  return { address, port };
}

async function readTail(filePath: string, maxBytes: number): Promise<{ bytesRead: number; content: string; truncated: boolean }> {
  const stats = await fs.stat(filePath);
  const bytesToRead = Math.min(stats.size, maxBytes);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, stats.size - bytesToRead);
    return {
      bytesRead: bytesToRead,
      content: buffer.toString("utf8"),
      truncated: stats.size > maxBytes,
    };
  } finally {
    await handle.close();
  }
}

export function registerProcessListTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "process_list",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description: "List local operating-system processes.",
      inputSchema: {
        includeCommandLine: z.boolean().optional().default(false),
        maxProcesses: z.number().int().positive().max(2_000).optional().default(500),
      },
      outputSchema: {
        processes: z.array(
          z.object({
            commandLine: z.string().optional(),
            name: z.string(),
            parentPid: z.number().optional(),
            pid: z.number(),
          }),
        ),
        truncated: z.boolean(),
      },
      title: "List Processes",
    },
    async ({ includeCommandLine, maxProcesses }) => {
      const startedAt = Date.now();
      try {
        requireScope(runtime.context, SCOPES.process);
        assertPolicyModeAllowed(runtime.config, "observe");
        let processes: ProcessInfo[];
        if (process.platform === "win32") {
          const command = includeCommandLine
            ? "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"
            : "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress";
          const { args, executable } = psJsonCommand(command);
          const result = await runSystemCommand(runtime, executable, args);
          if (result.code !== 0) throw new Error(result.stderr || "process_list failed");
          processes = parsePowerShellJson<Record<string, unknown>>(result.stdout, []).map((item) => ({
            commandLine: typeof item.CommandLine === "string" ? redactShellCommand(item.CommandLine) : undefined,
            name: String(item.Name || ""),
            parentPid: typeof item.ParentProcessId === "number" ? item.ParentProcessId : undefined,
            pid: Number(item.ProcessId),
          }));
        } else {
          const result = await runSystemCommand(runtime, "ps", ["-eo", "pid=,ppid=,comm=,args="]);
          if (result.code !== 0) throw new Error(result.stderr || "process_list failed");
          processes = result.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line): ProcessInfo | undefined => {
              const match = /^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
              return match
                ? {
                    commandLine: includeCommandLine ? redactShellCommand(match[4] || "") : undefined,
                    name: match[3],
                    parentPid: Number.parseInt(match[2], 10),
                    pid: Number.parseInt(match[1], 10),
                  }
                : undefined;
            })
            .filter((item): item is ProcessInfo => item !== undefined);
        }
        const truncated = processes.length > maxProcesses;
        processes = processes.slice(0, maxProcesses);
        await runtime.journal.append({
          argsRedacted: redactArgs({ includeCommandLine, maxProcesses }),
          durationMs: Date.now() - startedAt,
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "success",
          requiredScope: SCOPES.process,
          timestamp: new Date().toISOString(),
          tool: "process_list",
        });
        return jsonText({ processes, truncated });
      } catch (error) {
        await runtime.journal.append({
          argsRedacted: redactArgs({ includeCommandLine, maxProcesses }),
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.process,
          timestamp: new Date().toISOString(),
          tool: "process_list",
        });
        return errorText(error);
      }
    },
  );
}

export function registerPortListTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "port_list",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description: "List local TCP/UDP ports using netstat.",
      inputSchema: {
        protocol: z.enum(["tcp", "udp", "all"]).optional().default("all"),
      },
      outputSchema: {
        ports: z.array(
          z.object({
            localAddress: z.string(),
            localPort: z.number(),
            pid: z.number(),
            protocol: z.enum(["tcp", "udp"]),
            remoteAddress: z.string().optional(),
            remotePort: z.number().optional(),
            state: z.string().optional(),
          }),
        ),
      },
      title: "List Ports",
    },
    async ({ protocol }) => {
      const startedAt = Date.now();
      try {
        requireScope(runtime.context, SCOPES.process);
        assertPolicyModeAllowed(runtime.config, "observe");
        const args = process.platform === "win32" ? ["-ano"] : ["-anp"];
        const result = await runSystemCommand(runtime, "netstat", args);
        if (result.code !== 0) throw new Error(result.stderr || "port_list failed");
        const ports = parseNetstat(result.stdout).filter((item) => protocol === "all" || item.protocol === protocol);
        await runtime.journal.append({
          argsRedacted: redactArgs({ protocol }),
          durationMs: Date.now() - startedAt,
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "success",
          requiredScope: SCOPES.process,
          timestamp: new Date().toISOString(),
          tool: "port_list",
        });
        return jsonText({ ports });
      } catch (error) {
        await runtime.journal.append({
          argsRedacted: redactArgs({ protocol }),
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.process,
          timestamp: new Date().toISOString(),
          tool: "port_list",
        });
        return errorText(error);
      }
    },
  );
}

export function registerWaitForPortTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "wait_for_port",
    {
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: true },
      description: "Wait until a TCP host:port becomes reachable.",
      inputSchema: {
        allowRemote: z.boolean().optional().default(false),
        host: z.string().optional().default("127.0.0.1"),
        intervalMs: z.number().int().positive().max(10_000).optional().default(250),
        port: z.number().int().positive().max(65_535),
        timeoutMs: z.number().int().positive().max(120_000).optional().default(30_000),
      },
      outputSchema: {
        elapsedMs: z.number(),
        host: z.string(),
        port: z.number(),
        reachable: z.boolean(),
      },
      title: "Wait For Port",
    },
    async ({ allowRemote, host, intervalMs, port, timeoutMs }) => {
      const startedAt = Date.now();
      try {
        requireScope(runtime.context, SCOPES.process);
        assertPolicyModeAllowed(runtime.config, "diagnose");
        if (!allowRemote && !isLoopbackHost(host)) {
          throw new Error("wait_for_port only allows loopback hosts unless allowRemote=true");
        }
        let reachable = false;
        while (Date.now() - startedAt < timeoutMs) {
          reachable = await canConnect(host, port, Math.min(intervalMs, 2_000));
          if (reachable) break;
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        const elapsedMs = Date.now() - startedAt;
        await runtime.journal.append({
          argsRedacted: redactArgs({ allowRemote, host, intervalMs, port, timeoutMs }),
          durationMs: elapsedMs,
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: reachable ? "success" : "error",
          requiredScope: SCOPES.process,
          timestamp: new Date().toISOString(),
          tool: "wait_for_port",
        });
        const response = jsonText({ elapsedMs, host, port, reachable });
        return reachable ? response : { ...response, isError: true };
      } catch (error) {
        await runtime.journal.append({
          argsRedacted: redactArgs({ allowRemote, host, intervalMs, port, timeoutMs }),
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.process,
          timestamp: new Date().toISOString(),
          tool: "wait_for_port",
        });
        return errorText(error);
      }
    },
  );
}

function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

export function registerTailLogTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "tail_log",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
      description: "Preferred tool for reading log tails or stdout/stderr from a managed process. Use this instead of shell Get-Content -Tail, tail, or polling log files when practical.",
      inputSchema: {
        cwd: z.string().optional().describe("Base directory for relative log path resolution."),
        maxBytes: z.number().int().positive().max(1_000_000).optional().default(100_000),
        path: z.string().optional().describe("Log file path to tail."),
        processId: z.string().uuid().optional().describe("Managed process id returned by start_process."),
        stream: z.enum(["stdout", "stderr"]).optional().default("stdout"),
      },
      outputSchema: {
        bytesRead: z.number(),
        content: z.string(),
        path: z.string(),
        truncated: z.boolean(),
      },
      title: "Tail Log",
    },
    async ({ cwd, maxBytes, path: inputPath, processId, stream }) => {
      const startedAt = Date.now();
      let resolvedPath = "";
      try {
        requireScope(runtime.context, SCOPES.process);
        assertPolicyModeAllowed(runtime.config, "observe");
        await hydrateManagedProcesses(runtime);
        if (processId) {
          const record = managedProcesses.get(processId);
          if (!record) throw new Error(`Unknown managed process id: ${processId}`);
          resolvedPath = stream === "stderr" ? record.stderrPath : record.stdoutPath;
        } else {
          if (!inputPath) throw new Error("Either path or processId is required");
          const base = cwd ? await resolveCwd(cwd) : runtime.config.defaultCwd;
          resolvedPath = resolveFromCwd(base, inputPath);
          await assertPathTargetAllowed(runtime.config, resolvedPath, "observe", { checkSecret: true });
        }
        const result = await readTail(resolvedPath, maxBytes);
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, maxBytes, path: inputPath, processId, stream }),
          durationMs: Date.now() - startedAt,
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "success",
          requiredScope: SCOPES.process,
          timestamp: new Date().toISOString(),
          tool: "tail_log",
        });
        return jsonText({ ...result, path: resolvedPath });
      } catch (error) {
        await runtime.journal.append({
          argsRedacted: redactArgs({ cwd, maxBytes, path: inputPath, processId, stream }),
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.process,
          timestamp: new Date().toISOString(),
          tool: "tail_log",
        });
        return errorText(error);
      }
    },
  );
}

export function registerStartProcessTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "start_process",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description:
        "Preferred tool for starting long-running local processes such as dev servers. Use this instead of shell Start-Process, npm run dev, npm start, vite, or watch commands when the process should keep running; stdout/stderr are captured to managed log files and stop_process can clean it up. Prefer the narrowest practical cwd for the process root; full access remains available.",
      inputSchema: {
        command: z.string().min(1),
        confirm: z.boolean().optional().default(false),
        cwd: z.string().describe("Required working directory."),
        dryRun: z.boolean().optional().default(true),
        maxLogBytes: z.number().int().positive().max(HARD_PROCESS_LOG_BYTES).optional().default(DEFAULT_PROCESS_LOG_BYTES),
      },
      outputSchema: {
        ...dryRunOutputSchema,
        commandRedacted: z.string(),
        cwd: z.string(),
        effectivePathHints: z
          .array(
            z.object({
              absolutePath: z.string(),
              token: z.string(),
            }),
          )
          .optional(),
        maxLogBytes: z.number(),
        pid: z.number().optional(),
        processId: z.string().optional(),
        stderrPath: z.string().optional(),
        stdoutPath: z.string().optional(),
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
      },
      title: "Start Process",
    },
    async ({ command, confirm, cwd, dryRun, maxLogBytes }) => {
      try {
        requireScope(runtime.context, SCOPES.process);
        assertPolicyModeAllowed(runtime.config, "operate");
        await hydrateManagedProcesses(runtime);
        const resolvedCwd = await resolveCwd(cwd);
        await assertPathTargetAllowed(runtime.config, resolvedCwd, "operate", { checkSecret: true });
        requireConfirmedExecution(dryRun, confirm);
        const commandRedacted = redactShellCommand(command);
        const { effectivePathHints, warnings } = warningsForCommand(resolvedCwd, command);
        assertCommandPolicyAllowed({
          command,
          config: runtime.config,
          cwd: resolvedCwd,
          policy: runtime.config.processPolicy,
          policyMode: "operate",
          tool: "start_process",
        });
        if (dryRun) {
          return jsonText({ commandRedacted, confirmed: confirm, cwd: resolvedCwd, dryRun: true, effectivePathHints, maxLogBytes, warnings });
        }
        pruneManagedProcesses();
        if (managedProcesses.size >= MAX_MANAGED_PROCESSES) {
          throw new Error(`Too many managed processes: ${managedProcesses.size} >= ${MAX_MANAGED_PROCESSES}`);
        }
        const processId = randomUUID();
        const dir = path.join(processDataDir(runtime), processId);
        const stdoutPath = path.join(dir, "stdout.log");
        const stderrPath = path.join(dir, "stderr.log");
        await fs.mkdir(dir, { recursive: true });
        const { args, executable } = shellCommandArgs(command);
        const result = await runJournaledOperation<ManagedProcess>({
          argsRedacted: redactArgs({ command: commandRedacted, cwd, dryRun, executable, maxLogBytes }),
          cwd: resolvedCwd,
          effect: async () => {
            const child = spawn(executable, args, {
              cwd: resolvedCwd,
              detached: process.platform !== "win32",
              env: sanitizedRunnerEnv(),
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            });
            const record: ManagedProcess = {
              command: commandRedacted,
              cwd: resolvedCwd,
              id: processId,
              maxLogBytes,
              pid: child.pid || 0,
              startedAt: new Date().toISOString(),
              status: "running",
              stderrBytes: 0,
              stderrPath,
              stderrTruncated: false,
              stdoutBytes: 0,
              stdoutPath,
              stdoutTruncated: false,
            };
            const stdout = attachCappedLog(child.stdout, stdoutPath, record, "stdout");
            const stderr = attachCappedLog(child.stderr, stderrPath, record, "stderr");
            managedProcesses.set(processId, record);
            await writeManagedProcessMetadata(runtime, record);
            child.on("close", (code, signal) => {
              record.exitCode = code;
              record.signal = signal;
              record.status = "exited";
              stdout.end();
              stderr.end();
              void writeManagedProcessMetadata(runtime, record);
            });
            child.on("error", () => {
              stdout.end();
              stderr.end();
            });
            child.unref();
            return record;
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          outcomeFromResult: () => ({ outcome: "success" }),
          requiredScope: SCOPES.process,
          requestId: runtime.context.requestId,
          tool: "start_process",
        });
        return jsonText({
          commandRedacted,
          confirmed: confirm,
          cwd: resolvedCwd,
          dryRun: false,
          effectivePathHints,
          maxLogBytes,
          pid: result.pid,
          processId: result.id,
          stderrPath: result.stderrPath,
          stdoutPath: result.stdoutPath,
          warnings,
        });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerStopProcessTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "stop_process",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description: "Stop a process started by start_process.",
      inputSchema: {
        confirm: z.boolean().optional().default(false),
        dryRun: z.boolean().optional().default(true),
        processId: z.string().uuid(),
      },
      outputSchema: {
        ...dryRunOutputSchema,
        code: z.union([z.number(), z.null()]).optional(),
        exited: z.boolean(),
        pid: z.number().optional(),
        processId: z.string(),
        stderr: z.string().optional(),
        stdout: z.string().optional(),
        stopped: z.boolean(),
      },
      title: "Stop Managed Process",
    },
    async ({ confirm, dryRun, processId }) => {
      try {
        requireScope(runtime.context, SCOPES.process);
        assertPolicyModeAllowed(runtime.config, "operate");
        await hydrateManagedProcesses(runtime);
        const record = managedProcesses.get(processId);
        if (!record) throw new Error(`Unknown managed process id: ${processId}`);
        requireConfirmedExecution(dryRun, confirm);
        if (dryRun) {
          return jsonText({ confirmed: confirm, dryRun: true, exited: record.status === "exited", pid: record.pid, processId, stopped: false });
        }
        if (record.status === "exited") {
          return jsonText({
            code: record.exitCode ?? null,
            confirmed: confirm,
            dryRun: false,
            exited: true,
            pid: record.pid,
            processId,
            stopped: false,
          });
        }
        const result = await runJournaledOperation({
          argsRedacted: redactArgs({ confirm, dryRun, processId }),
          cwd: record.cwd,
          effect: async () => {
            if (process.platform === "win32") {
              return runSystemCommand(runtime, "taskkill.exe", ["/PID", String(record.pid), "/T", "/F"], 10_000);
            }
            return runSystemCommand(runtime, "kill", ["-TERM", String(record.pid)], 10_000);
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          outcomeFromResult: (result) => ({ exitCode: result.code, outcome: result.code === 0 ? "success" : "error" }),
          requiredScope: SCOPES.process,
          requestId: runtime.context.requestId,
          tool: "stop_process",
        });
        if (result.code === 0) {
          record.status = "exited";
          record.exitCode = result.code;
          await writeManagedProcessMetadata(runtime, record);
        }
        const response = jsonText({
          code: result.code,
          confirmed: confirm,
          dryRun: false,
          exited: false,
          pid: record.pid,
          processId,
          stderr: result.stderr,
          stopped: result.code === 0,
          stdout: result.stdout,
        });
        return result.code === 0 ? response : { ...response, isError: true };
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerProcessKillTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "process_kill",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description: "Kill a local process by PID.",
      inputSchema: {
        allowCritical: z.boolean().optional().default(false),
        confirm: z.boolean().optional().default(false),
        dryRun: z.boolean().optional().default(true),
        expectedCommandSubstring: z.string().optional(),
        expectedName: z.string().optional(),
        pid: z.number().int().positive(),
        tree: z.boolean().optional().default(true),
      },
      outputSchema: {
        ...dryRunOutputSchema,
        commandLine: z.string().optional(),
        expectedName: z.string().optional(),
        killed: z.boolean(),
        name: z.string().optional(),
        pid: z.number(),
        ...commandResultOutputSchema,
      },
      title: "Kill Process",
    },
    async ({ allowCritical, confirm, dryRun, expectedCommandSubstring, expectedName, pid, tree }) => {
      try {
        requireScope(runtime.context, SCOPES.process);
        assertPolicyModeAllowed(runtime.config, "operate");
        if (pid === process.pid) {
          throw new Error("Refusing to kill the MCP server process");
        }
        if (process.ppid && pid === process.ppid) {
          throw new Error("Refusing to kill the MCP server parent process");
        }
        const processInfo = await getProcessInfo(runtime, pid);
        if (!processInfo) {
          throw new Error(`Process not found: ${pid}`);
        }
        const processName = processInfo.name.toLowerCase();
        if (!allowCritical && CRITICAL_PROCESS_NAMES.has(processName)) {
          throw new Error(`Refusing to kill critical process ${processInfo.name} without allowCritical=true`);
        }
        if (expectedName && processName !== expectedName.toLowerCase()) {
          throw new Error(`Process name mismatch for ${pid}: expected ${expectedName}, got ${processInfo.name}`);
        }
        if (expectedCommandSubstring && !(processInfo.commandLine || "").includes(expectedCommandSubstring)) {
          throw new Error(`Process command line mismatch for ${pid}: expected substring not found`);
        }
        requireConfirmedExecution(dryRun, confirm);
        if (dryRun) {
          return jsonText({
            code: null,
            commandLine: processInfo.commandLine,
            confirmed: confirm,
            dryRun: true,
            expectedName,
            killed: false,
            name: processInfo.name,
            outputLimitExceeded: false,
            pid,
            signal: null,
            stderr: "",
            stderrTruncated: false,
            stdout: "",
            stdoutTruncated: false,
            timedOut: false,
          });
        }
        const result = await runJournaledOperation({
          argsRedacted: redactArgs({ allowCritical, confirm, dryRun, expectedCommandSubstring, expectedName, pid, tree }),
          effect: async () => {
            if (process.platform === "win32") {
              return runSystemCommand(runtime, "taskkill.exe", tree ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/F"], 10_000);
            }
            return runSystemCommand(runtime, "kill", ["-TERM", String(pid)], 10_000);
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          outcomeFromResult: (result) => ({ exitCode: result.code, outcome: result.code === 0 ? "success" : "error" }),
          requiredScope: SCOPES.process,
          requestId: runtime.context.requestId,
          tool: "process_kill",
        });
        const response = jsonText({
          commandLine: processInfo.commandLine,
          confirmed: confirm,
          dryRun: false,
          expectedName,
          killed: result.code === 0,
          name: processInfo.name,
          pid,
          ...result,
        });
        return result.code === 0 ? response : { ...response, isError: true };
      } catch (error) {
        return errorText(error);
      }
    },
  );
}
