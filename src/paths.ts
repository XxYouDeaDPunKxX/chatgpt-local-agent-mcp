import fs from "node:fs/promises";
import path from "node:path";

export type ToolWarning = {
  code: string;
  cwd?: string;
  message: string;
  path?: string;
  severity: "info" | "warning";
  suggestion?: string;
};

export async function resolveCwd(cwd: string): Promise<string> {
  const absolute = path.resolve(cwd);
  const stats = await fs.stat(absolute);
  if (!stats.isDirectory()) {
    throw new Error(`cwd is not a directory: ${cwd}`);
  }
  return absolute;
}

export function resolveFromCwd(cwd: string, inputPath: string): string {
  return path.resolve(cwd, inputPath);
}

function containsPath(rootPath: string, candidatePath: string): boolean {
  const root = process.platform === "win32" ? path.resolve(rootPath).toLowerCase() : path.resolve(rootPath);
  const candidate = process.platform === "win32" ? path.resolve(candidatePath).toLowerCase() : path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function cwdBreadthWarning(cwd: string, targetPath: string): ToolWarning | undefined {
  const resolvedCwd = path.resolve(cwd);
  const resolvedTarget = path.resolve(targetPath);
  const targetDirectory = path.dirname(resolvedTarget);
  if (targetDirectory === resolvedCwd || !containsPath(resolvedCwd, resolvedTarget)) {
    return undefined;
  }

  return {
    code: "cwd_broader_than_target",
    cwd: resolvedCwd,
    message: "cwd is broader than the target path. Full access is allowed, but a narrower cwd improves audit clarity.",
    path: resolvedTarget,
    severity: "warning",
    suggestion: `Prefer cwd=${targetDirectory} with path=${path.basename(resolvedTarget)} when practical.`,
  };
}

export function shellAuditWarning(): ToolWarning {
  return {
    code: "shell_effects_not_granular",
    message:
      "shell runs with full access and can create or modify files without per-file effects in the response. Prefer filesystem tools for file creation/editing when practical.",
    severity: "info",
  };
}

export function relativePathHintsFromCommand(cwd: string, command: string): Array<{ absolutePath: string; token: string }> {
  const hints = new Map<string, { absolutePath: string; token: string }>();
  const quotedPathPattern = /["']([^"']*[\\/][^"']*)["']/g;
  const barePathPattern = /(?<![A-Za-z]+:)(?:\.{1,2}[\\/])?(?:[\w.@()[\]-]+[\\/])+[\w.@()[\]-]+/g;
  const tokens = [
    ...[...command.matchAll(quotedPathPattern)].map((match) => match[1]),
    ...[...command.matchAll(barePathPattern)].map((match) => match[0]),
  ];
  for (const tokenValue of tokens) {
    const token = tokenValue.trim();
    if (!token || /^[A-Za-z]:[\\/]/.test(token) || token.includes("://")) {
      continue;
    }
    const absolutePath = path.resolve(cwd, token);
    hints.set(absolutePath, { absolutePath, token });
  }
  return [...hints.values()].slice(0, 20);
}

function expectedPathHints(cwd: string, expectedTouchedPaths: string[]): Array<{ absolutePath: string; token: string }> {
  return expectedTouchedPaths
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => ({
      absolutePath: path.resolve(cwd, token),
      token,
    }));
}

function dedicatedToolWarningsForCommand(command: string): ToolWarning[] {
  const warnings: ToolWarning[] = [];
  const add = (suggestion: string) => {
    if (!warnings.some((warning) => warning.suggestion === suggestion)) {
      warnings.push({
        code: "dedicated_tool_available",
        message: "A more specific MCP tool may provide better schema, dry-run behavior, and journal effects than shell.",
        severity: "info",
        suggestion,
      });
    }
  };

  if (/\b(Set-Content|Out-File|Add-Content)\b|(?:^|[^2])>\s*[^&|]/i.test(command)) {
    add("Prefer write_file or apply_patch for auditable file creation/editing when practical.");
  }
  if (/\b(New-Item\b[^;\n]*-ItemType\s+Directory|mkdir|md)\b/i.test(command)) {
    add("Prefer mkdir for auditable directory creation when practical.");
  }
  if (/\bgit\s+status\b/i.test(command)) {
    add("Prefer git_status for repository state checks when practical.");
  }
  if (/\bgit\s+diff\b/i.test(command)) {
    add("Prefer git_diff for repository diffs when practical.");
  }
  if (/\bgit\s+commit\b/i.test(command)) {
    add("Prefer git_commit for commits because it has dry-run/confirm semantics.");
  }
  if (/\b(Remove-Item|del|erase|rm)\b/i.test(command)) {
    add("Prefer delete or move for file destructive operations because they support dry-run/confirm and backups.");
  }
  if (/\b(Start-Process)\b|\bnpm\s+run\s+(dev|start)\b|\b(vite|tsx)\s+watch\b|\bnode\b[^\r\n]*(server|listen|app)\b/i.test(command)) {
    add("Prefer start_process for long-running servers so stdout/stderr are managed and stop_process can clean them up.");
  }
  if (/\b(Get-Content)\b[^\r\n]*\b(-Tail|-Wait)\b/i.test(command)) {
    add("Prefer tail_log for log inspection when practical.");
  }
  if (/\b(Select-String|grep|rg)\b/i.test(command)) {
    add("Prefer search for auditable bounded text search when practical.");
  }

  return warnings;
}

export function warningsForCommand(
  cwd: string,
  command: string,
  expectedTouchedPaths: string[] = [],
): { effectivePathHints: Array<{ absolutePath: string; token: string }>; warnings: ToolWarning[] } {
  const effectivePathHints = [...relativePathHintsFromCommand(cwd, command), ...expectedPathHints(cwd, expectedTouchedPaths)];
  const dedupedHints = [...new Map(effectivePathHints.map((hint) => [hint.absolutePath, hint])).values()].slice(0, 20);
  const warnings = [shellAuditWarning(), ...dedicatedToolWarningsForCommand(command)];
  for (const hint of dedupedHints) {
    const warning = cwdBreadthWarning(cwd, hint.absolutePath);
    if (warning && !warnings.some((item) => item.code === warning.code && item.path === warning.path)) {
      warnings.push(warning);
    }
  }
  return { effectivePathHints: dedupedHints, warnings };
}
