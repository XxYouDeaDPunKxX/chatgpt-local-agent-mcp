import path from "node:path";
import { AppConfig, CommandPolicy } from "./config.js";
import { assertPathAllowed } from "./guards.js";
import { PolicyMode } from "./policy.js";

type CommandPathHint = {
  absolutePath: string;
  token: string;
};

const ABSOLUTE_OR_RELATIVE_PATH_PATTERN =
  /(?:[A-Za-z]:[\\/][^"'`\s|;&<>]+|\\\\[^"'`\s|;&<>]+(?:[\\/][^"'`\s|;&<>]+)*|(?:\.{1,2}[\\/])?(?:[\w.@()[\]-]+[\\/])+[\w.@()[\]-]+)/g;
const BARE_SENSITIVE_PATH_PATTERN =
  /(?<![A-Za-z0-9_.-])(?:\.env(?:\.[\w.-]+)?|[\w.@()[\]-]*(?:secret|token|credential)[\w.@()[\]-]*)(?![A-Za-z0-9_.-])/gi;
const QUOTED_TOKEN_PATTERN = /["']([^"']+)["']/g;

function looksLikePath(value: string): boolean {
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\");
}

function resolveCommandPathToken(cwd: string, token: string): CommandPathHint | undefined {
  const trimmed = token.trim();
  if (!trimmed || trimmed.includes("://") || !looksLikePath(trimmed)) {
    return undefined;
  }
  return {
    absolutePath: path.resolve(cwd, trimmed),
    token: trimmed,
  };
}

export function commandPathHints(cwd: string, command: string, expectedTouchedPaths: string[] = []): CommandPathHint[] {
  const hints = new Map<string, CommandPathHint>();
  const add = (hint: CommandPathHint | undefined) => {
    if (hint) hints.set(hint.absolutePath, hint);
  };

  for (const match of command.matchAll(QUOTED_TOKEN_PATTERN)) {
    add(resolveCommandPathToken(cwd, match[1]));
  }
  for (const match of command.matchAll(ABSOLUTE_OR_RELATIVE_PATH_PATTERN)) {
    add(resolveCommandPathToken(cwd, match[0]));
  }
  for (const match of command.matchAll(BARE_SENSITIVE_PATH_PATTERN)) {
    add({
      absolutePath: path.resolve(cwd, match[0]),
      token: match[0],
    });
  }
  for (const token of expectedTouchedPaths) {
    add(resolveCommandPathToken(cwd, token));
  }

  return [...hints.values()].slice(0, 50);
}

export function commandLooksMutative(command: string): boolean {
  return /\b(Set-Content|Out-File|Add-Content|New-Item|Remove-Item|del|erase|rm|rmdir|mkdir|md|Copy-Item|Move-Item|Rename-Item|Start-Process)\b|(?:^|[^2])>\s*[^&|]/i.test(
    command,
  );
}

export function assertCommandPolicyAllowed({
  command,
  config,
  cwd,
  expectedTouchedPaths = [],
  policy,
  policyMode,
  tool,
}: {
  command: string;
  config: AppConfig;
  cwd: string;
  expectedTouchedPaths?: string[];
  policy: CommandPolicy;
  policyMode: PolicyMode;
  tool: "shell" | "start_process";
}): void {
  if (policy === "disabled") {
    throw new Error(`${tool} is disabled by command policy`);
  }
  if (policy === "full") {
    return;
  }

  if (tool === "shell" && commandLooksMutative(command) && expectedTouchedPaths.length === 0) {
    throw new Error("workspace_guarded shell requires expectedTouchedPaths for recognized mutative commands");
  }

  for (const hint of commandPathHints(cwd, command, expectedTouchedPaths)) {
    assertPathAllowed(config, hint.absolutePath, policyMode, { checkSecret: true });
  }
}
