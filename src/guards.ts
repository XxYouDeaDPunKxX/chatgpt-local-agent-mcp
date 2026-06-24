import path from "node:path";
import fs from "node:fs/promises";
import { AppConfig, WorkspaceProfile } from "./config.js";
import { isPolicyModeAllowed, PolicyMode } from "./policy.js";

export type PathGuardOptions = {
  checkSecret?: boolean;
};

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeForGlob(value: string): string {
  return path.resolve(value).replace(/\\/g, "/");
}

function samePath(left: string, right: string): boolean {
  return normalizeForCompare(left) === normalizeForCompare(right);
}

export function containsPath(rootPath: string, candidatePath: string): boolean {
  const root = normalizeForCompare(rootPath);
  const candidate = normalizeForCompare(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function profileForPath(config: AppConfig, candidatePath: string): WorkspaceProfile | undefined {
  return [...config.workspaceProfiles]
    .filter((profile) => containsPath(profile.rootPath, candidatePath))
    .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/");
  let source = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];
    if (char === "*" && next === "*") {
      const afterNext = normalized[i + 2];
      if (afterNext === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`(^|/)${source}$`, process.platform === "win32" ? "i" : "");
}

export function matchesSecretDenyGlob(filePath: string, globs: string[]): boolean {
  const normalized = normalizeForGlob(filePath);
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

function secretGlobsForPath(config: AppConfig, filePath: string): string[] {
  return profileForPath(config, filePath)?.secretDenyGlobs || config.workspaceProfiles[0]?.secretDenyGlobs || [];
}

export function isSensitivePath(config: AppConfig, filePath: string): boolean {
  const absolutePath = path.resolve(filePath);
  const runtimeDataDir = path.dirname(path.resolve(config.journalPath));
  const runtimeProtectedDirs = [
    config.backupDir,
    path.join(runtimeDataDir, "browser"),
    path.join(runtimeDataDir, "processes"),
    path.join(runtimeDataDir, "screenshots"),
    path.join(process.cwd(), "logs"),
  ];
  const runtimeProtectedFiles = [
    path.join(process.cwd(), "server.out.log"),
    path.join(process.cwd(), "server.err.log"),
    path.join(runtimeDataDir, "cloudflared.out.log"),
    path.join(runtimeDataDir, "cloudflared.err.log"),
  ];
  return (
    runtimeProtectedDirs.some((directory) => containsPath(directory, absolutePath)) ||
    runtimeProtectedFiles.some((protectedFile) => samePath(protectedFile, absolutePath)) ||
    matchesSecretDenyGlob(absolutePath, secretGlobsForPath(config, absolutePath))
  );
}

export function assertPathAllowed(
  config: AppConfig,
  filePath: string,
  policyMode: PolicyMode,
  options: PathGuardOptions = {},
): void {
  const absolutePath = path.resolve(filePath);
  const profile = profileForPath(config, absolutePath);

  if (config.enforceWorkspaceProfiles) {
    if (!profile) {
      throw new Error(`Path is outside configured workspace profiles: ${absolutePath}`);
    }
    if (!profile.allowedPolicyModes.includes(policyMode)) {
      throw new Error(`Workspace profile ${profile.name} does not allow policy mode ${policyMode}: ${absolutePath}`);
    }
  }

  if (options.checkSecret !== false && isSensitivePath(config, absolutePath)) {
    throw new Error(`Path is blocked by sensitive path guards: ${absolutePath}`);
  }
}

export async function assertPathTargetAllowed(
  config: AppConfig,
  filePath: string,
  policyMode: PolicyMode,
  options: PathGuardOptions = {},
): Promise<void> {
  const absolutePath = path.resolve(filePath);
  assertPathAllowed(config, absolutePath, policyMode, options);

  let currentPath = absolutePath;
  for (;;) {
    try {
      const realPath = await fs.realpath(currentPath);
      assertPathAllowed(config, realPath, policyMode, options);
      return;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        throw error;
      }
      currentPath = parentPath;
    }
  }
}

export function assertPathsAllowed(
  config: AppConfig,
  filePaths: string[],
  policyMode: PolicyMode,
  options: PathGuardOptions = {},
): void {
  for (const filePath of filePaths) {
    assertPathAllowed(config, filePath, policyMode, options);
  }
}

export async function assertPathTargetsAllowed(
  config: AppConfig,
  filePaths: string[],
  policyMode: PolicyMode,
  options: PathGuardOptions = {},
): Promise<void> {
  for (const filePath of filePaths) {
    await assertPathTargetAllowed(config, filePath, policyMode, options);
  }
}

export function assertPolicyModeAllowed(config: AppConfig, policyMode: PolicyMode): void {
  if (!isPolicyModeAllowed(policyMode, config.maxPolicyMode)) {
    throw new Error(`Policy mode ${policyMode} exceeds GPT_FS_MCP_MAX_POLICY_MODE=${config.maxPolicyMode}`);
  }
}
