import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AppConfig } from "./config.js";
import { getFileSnapshot } from "./journal.js";

export type BackupRecord = {
  backupId: string;
  backupPath: string;
  createdAt: string;
  originalPath: string;
  reason?: string;
  skipped: boolean;
  size?: number;
  snapshotHash?: string;
  tool: string;
};

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function containsPath(rootPath: string, candidatePath: string): boolean {
  const root = normalizeForCompare(rootPath);
  const candidate = normalizeForCompare(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
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
    // Some Windows/filesystem targets cannot be fsynced through this path.
  }
}

async function writeFileDurable(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let tempCreated = false;

  await fs.mkdir(directory, { recursive: true });
  const handle = await fs.open(tempPath, "w");
  tempCreated = true;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fs.rename(tempPath, filePath);
    tempCreated = false;
    await fsyncPathBestEffort(directory);
  } finally {
    if (tempCreated) {
      await fs.rm(tempPath, { force: true });
    }
  }
}

export async function createFileBackup(config: AppConfig, originalPath: string, tool: string): Promise<BackupRecord> {
  const backupId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const backupRoot = path.resolve(config.backupDir, backupId);
  const backupPath = path.join(backupRoot, "content");
  const metadataPath = path.join(backupRoot, "metadata.json");
  const absoluteOriginalPath = path.resolve(originalPath);

  const baseRecord = {
    backupId,
    backupPath,
    createdAt,
    originalPath: absoluteOriginalPath,
    skipped: false,
    tool,
  };

  try {
    const stats = await fs.stat(absoluteOriginalPath);
    if (!stats.isFile()) {
      const record = { ...baseRecord, reason: "not_file", skipped: true, size: stats.size };
      await writeBackupMetadata(metadataPath, record);
      return record;
    }
    if (stats.size > config.maxBackupBytes) {
      const record = { ...baseRecord, reason: "too_large", skipped: true, size: stats.size };
      await writeBackupMetadata(metadataPath, record);
      return record;
    }

    await fs.mkdir(backupRoot, { recursive: true });
    await fs.copyFile(absoluteOriginalPath, backupPath);
    await fsyncPathBestEffort(backupPath);
    const snapshot = await getFileSnapshot(absoluteOriginalPath, config.maxBackupBytes);
    const record = {
      ...baseRecord,
      size: snapshot.size,
      snapshotHash: snapshot.hash,
    };
    await writeBackupMetadata(metadataPath, record);
    return record;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      const record = { ...baseRecord, reason: "missing", skipped: true };
      await writeBackupMetadata(metadataPath, record);
      return record;
    }
    throw error;
  }
}

export async function readBackupRecord(config: AppConfig, backupId: string): Promise<BackupRecord> {
  if (!/^[0-9a-f-]{36}$/i.test(backupId)) {
    throw new Error("Invalid backupId");
  }
  const backupRoot = path.resolve(config.backupDir, backupId);
  const backupPath = path.join(backupRoot, "content");
  const metadataPath = path.join(backupRoot, "metadata.json");
  if (!containsPath(config.backupDir, backupRoot) || !containsPath(backupRoot, backupPath)) {
    throw new Error("Invalid backup path");
  }
  const raw = await fs.readFile(metadataPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertObject(parsed, "backup metadata");

  const metadataBackupId = assertString(parsed.backupId, "backup metadata backupId");
  if (metadataBackupId !== backupId) {
    throw new Error("Backup metadata id mismatch");
  }
  const metadataBackupPath = assertString(parsed.backupPath, "backup metadata backupPath");
  if (normalizeForCompare(metadataBackupPath) !== normalizeForCompare(backupPath)) {
    throw new Error("Backup metadata path mismatch");
  }

  const skipped = assertBoolean(parsed.skipped, "backup metadata skipped");
  const record: BackupRecord = {
    backupId,
    backupPath,
    createdAt: assertString(parsed.createdAt, "backup metadata createdAt"),
    originalPath: path.resolve(assertString(parsed.originalPath, "backup metadata originalPath")),
    reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    skipped,
    size: typeof parsed.size === "number" ? parsed.size : undefined,
    snapshotHash: typeof parsed.snapshotHash === "string" ? parsed.snapshotHash : undefined,
    tool: assertString(parsed.tool, "backup metadata tool"),
  };

  if (!record.skipped) {
    await fs.access(record.backupPath);
    if (record.snapshotHash) {
      const snapshot = await getFileSnapshot(record.backupPath, config.maxBackupBytes);
      if (snapshot.hash !== record.snapshotHash) {
        throw new Error("Backup content hash mismatch");
      }
    }
  }

  return record;
}

export function assertBackupsRestorable(records: BackupRecord[], options: { allowMissing: boolean }): void {
  for (const record of records) {
    if (!record.skipped) {
      continue;
    }
    if (options.allowMissing && record.reason === "missing") {
      continue;
    }
    throw new Error(`Required backup for ${record.originalPath} was skipped: ${record.reason || "unknown"}`);
  }
}

export function restorableBackupIds(records: BackupRecord[]): string[] {
  return records.filter((record) => !record.skipped).map((record) => record.backupId);
}

async function writeBackupMetadata(metadataPath: string, record: BackupRecord): Promise<void> {
  await writeFileDurable(metadataPath, `${JSON.stringify(record, null, 2)}\n`);
}
