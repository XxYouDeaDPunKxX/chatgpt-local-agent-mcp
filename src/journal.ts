import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { ExecutionContext } from "./runtime.js";

export type FileEffect = {
  afterHash?: string;
  backupId?: string;
  beforeHash?: string;
  bytesAfter?: number;
  bytesBefore?: number;
  operation: "read" | "write" | "create" | "delete" | "mkdir" | "move" | "copy" | "patch" | "git_commit";
  path: string;
};

export type JournalPhase = "intent" | "outcome";
export type JournalOutcome = "success" | "error" | "unknown";

export type FileSnapshot = {
  exists: boolean;
  hash?: string;
  size?: number;
};

export type JournalEntry = {
  argsRedacted: unknown;
  backupIds?: string[];
  cwd?: string;
  durationMs?: number;
  effects?: FileEffect[];
  error?: string;
  exitCode?: number | null;
  id: string;
  identity: ExecutionContext["identity"];
  operationId?: string;
  outcome?: JournalOutcome;
  phase?: JournalPhase;
  requiredScope: string;
  signal?: string | null;
  snapshotError?: string;
  stderrTruncated?: boolean;
  stdoutTruncated?: boolean;
  timestamp: string;
  tool: string;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
};

const REDACTED_KEYS = new Set([
  "accessToken",
  "client_secret",
  "content",
  "password",
  "secret",
  "token",
]);

export class Journal {
  constructor(private readonly filePath: string) {}

  async ensureWritable(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const handle = await fs.open(this.filePath, "a");
    await handle.close();
  }

  async append(entry: JournalEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async appendDurable(entry: JournalEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const handle = await fs.open(this.filePath, "a");
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async markPendingOperationsUnknown(): Promise<string[]> {
    const pending = await this.pendingIntentEntries();
    const recovered: string[] = [];
    for (const [operationId, intent] of pending.entries()) {
      await this.appendDurable({
        argsRedacted: intent.argsRedacted,
        cwd: intent.cwd,
        durationMs: 0,
        effects: intent.effects,
        error: "Pending journal operation found at boot without outcome",
        id: crypto.randomUUID(),
        identity: intent.identity,
        operationId,
        outcome: "unknown",
        phase: "outcome",
        requiredScope: intent.requiredScope,
        timestamp: new Date().toISOString(),
        tool: intent.tool,
      });
      recovered.push(operationId);
    }
    return recovered;
  }

  private async pendingIntentEntries(): Promise<Map<string, JournalEntry>> {
    try {
      await fs.access(this.filePath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return new Map();
      }
      throw error;
    }

    const pending = new Map<string, JournalEntry>();
    const lines = createInterface({
      crlfDelay: Infinity,
      input: createReadStream(this.filePath, { encoding: "utf8" }),
    });

    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JournalEntry;
        if (!entry.operationId) continue;
        if (entry.phase === "intent") {
          pending.set(entry.operationId, entry);
        } else if (entry.phase === "outcome") {
          pending.delete(entry.operationId);
        }
      } catch {
        continue;
      }
    }
    return pending;
  }
}

async function captureSnapshot(
  snapshot: () => Promise<FileEffect[]>,
): Promise<{ effects?: FileEffect[]; snapshotError?: string }> {
  try {
    return { effects: await snapshot() };
  } catch (error) {
    return { snapshotError: error instanceof Error ? error.message : String(error) };
  }
}

export async function runJournaledOperation<T>({
  argsRedacted,
  afterSnapshot,
  beforeSnapshot,
  cwd,
  effect,
  identity,
  journal,
  requiredScope,
  requestId,
  tool,
  outcomeFromError,
  outcomeFromResult,
  outcomeDetails,
}: {
  argsRedacted: unknown;
  cwd?: string;
  effect: () => Promise<T>;
  identity: ExecutionContext["identity"];
  journal: Journal;
  requiredScope: string;
  requestId: string;
  afterSnapshot?: () => Promise<FileEffect[]>;
  beforeSnapshot?: () => Promise<FileEffect[]>;
  tool: string;
  outcomeFromError?: (error: unknown) => Partial<JournalEntry>;
  outcomeFromResult?: (result: T) => Partial<JournalEntry>;
  outcomeDetails?: () => Partial<JournalEntry> | Promise<Partial<JournalEntry>>;
}): Promise<T> {
  const operationId = crypto.randomUUID();
  const startedAt = Date.now();
  const beforeEffects = beforeSnapshot ? await beforeSnapshot() : [];

  await journal.appendDurable({
    argsRedacted,
    cwd,
    durationMs: 0,
    effects: beforeEffects,
    id: requestId,
    identity,
    operationId,
    phase: "intent",
    requiredScope,
    timestamp: new Date().toISOString(),
    tool,
  });

  try {
    const result = await effect();
    const after = afterSnapshot ? await captureSnapshot(afterSnapshot) : {};
    const details = (await outcomeDetails?.()) || {};
    const resultDetails = outcomeFromResult?.(result) || {};
    await journal.appendDurable({
      argsRedacted,
      cwd,
      durationMs: Date.now() - startedAt,
      effects: after.effects,
      id: requestId,
      identity,
      operationId,
      outcome: "success",
      phase: "outcome",
      requiredScope,
      snapshotError: after.snapshotError,
      timestamp: new Date().toISOString(),
      tool,
      ...details,
      ...resultDetails,
    });
    return result;
  } catch (error) {
    const after = afterSnapshot ? await captureSnapshot(afterSnapshot) : {};
    const details = (await outcomeDetails?.()) || {};
    const errorDetails = outcomeFromError?.(error) || {};
    await journal.appendDurable({
      argsRedacted,
      cwd,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      effects: after.effects,
      id: requestId,
      identity,
      operationId,
      outcome: "error",
      phase: "outcome",
      requiredScope,
      snapshotError: after.snapshotError,
      timestamp: new Date().toISOString(),
      tool,
      ...details,
      ...errorDetails,
    });
    throw error;
  }
}

export async function runJournaledMutation<T>({
  argsRedacted,
  afterSnapshot,
  beforeSnapshot,
  cwd,
  effect,
  identity,
  journal,
  requiredScope,
  requestId,
  tool,
  outcomeDetails,
}: {
  argsRedacted: unknown;
  cwd?: string;
  effect: () => Promise<T>;
  identity: ExecutionContext["identity"];
  journal: Journal;
  requiredScope: string;
  requestId: string;
  afterSnapshot: () => Promise<FileEffect[]>;
  beforeSnapshot: () => Promise<FileEffect[]>;
  tool: string;
  outcomeDetails?: () => Partial<JournalEntry> | Promise<Partial<JournalEntry>>;
}): Promise<T> {
  return runJournaledOperation({
    afterSnapshot,
    argsRedacted,
    beforeSnapshot,
    cwd,
    effect,
    identity,
    journal,
    requiredScope,
    requestId,
    tool,
    outcomeDetails,
  });
}

export function redactShellCommand(command: string): string {
  return command
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/(--(?:api-key|password|secret|token)\s+)(?:"[^"]*"|'[^']*'|[^\s"'`]+)/gi, "$1[REDACTED]")
    .replace(
      /(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s&"'`]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/((?:api[_-]?key|client[_-]?secret|password|secret|token)=)(?:"[^"]*"|'[^']*'|[^\s&"'`]+)/gi, "$1[REDACTED]");
}

export function redactArgs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactArgs(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      REDACTED_KEYS.has(key) || key.toLowerCase().includes("secret") || key.toLowerCase().includes("token")
        ? "[REDACTED]"
        : redactArgs(nested),
    ]),
  );
}

export function sha256Hex(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function getFileSnapshot(filePath: string, maxHashBytes: number): Promise<FileSnapshot> {
  try {
    const stats = await fs.stat(filePath);
    if (stats.size > maxHashBytes) {
      return { exists: true, size: stats.size };
    }
    const hash = crypto.createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on("data", (chunk: Buffer | string) => {
        hash.update(chunk);
      });
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    return {
      exists: true,
      hash: hash.digest("hex"),
      size: stats.size,
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}
