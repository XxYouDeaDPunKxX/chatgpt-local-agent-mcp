import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PolicyMode, parsePolicyMode, policyModesUpTo } from "./policy.js";
import { ALL_SCOPES, Scope } from "./scopes.js";
import { SCOPES } from "./scopes.js";

export type WorkspaceProfile = {
  allowedPolicyModes: PolicyMode[];
  backupPolicy: "none" | "manual" | "snapshot";
  label: string;
  name: string;
  rootPath: string;
  secretDenyGlobs: string[];
};

export type CommandPolicy = "disabled" | "workspace_guarded" | "full";

export type AppConfig = {
  allowedHosts: string[];
  allowedGithubLogins: string[];
  authRateLimitMaxBuckets: number;
  authRateLimitMax: number;
  authRateLimitWindowMs: number;
  authRequired: boolean;
  authRequirePkce: boolean;
  authStoreMaxAuthCodes: number;
  authStoreMaxPending: number;
  authStoreMaxTokens: number;
  authStoreCleanupIntervalMs: number;
  backupDir: string;
  browserSessionIdleMs: number;
  maxBrowserLogEntries: number;
  maxBrowserScreenshotFiles: number;
  maxBrowserScreenshotBytes: number;
  maxBrowserSessions: number;
  cloudflareTunnelEnabled: boolean;
  defaultCwd: string;
  defaultOauthScopes: string[];
  devIdentityLogin: string;
  exposeRuntimeDebug: boolean;
  enforceWorkspaceProfiles: boolean;
  githubClientId?: string;
  githubClientSecret?: string;
  host: string;
  journalPath: string;
  maxBodyBytes: number;
  maxBackupBytes: number;
  maxOutputBytes: number;
  maxPolicyMode: PolicyMode;
  maxScreenshotAreaPixels: number;
  maxScreenshotBytes: number;
  maxScreenshotDimension: number;
  maxScreenshotFiles: number;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthRedirectUris: string[];
  port: number;
  protectedResourceMetadataUrl: string;
  publicBaseUrl: string;
  resourceUri: string;
  processPolicy: CommandPolicy;
  shellTimeoutMs: number;
  shellPolicy: CommandPolicy;
  trustProxyHeaders: boolean;
  workspaceProfiles: WorkspaceProfile[];
};

function readInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean: true/false, 1/0, yes/no, or on/off`);
}

function readCommaList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readCommandPolicy(name: string, fallback: CommandPolicy): CommandPolicy {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (raw !== "disabled" && raw !== "workspace_guarded" && raw !== "full") {
    throw new Error(`${name} must be one of: disabled, workspace_guarded, full`);
  }
  return raw;
}

function readScopeList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

function normalizeAllowedHost(hostname: string): string {
  return hostname === "::1" ? "[::1]" : hostname;
}

function validateRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`OAUTH_REDIRECT_URIS contains invalid URI: ${uri}`);
  }

  if (isLoopbackHostname(parsed.hostname)) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Loopback redirect URI must use http or https: ${uri}`);
    }
    return;
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`Non-local redirect URI must use https: ${uri}`);
  }
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required when AUTH_REQUIRED=true`);
  }
  return value;
}

function defaultSecretDenyGlobs(): string[] {
  return [
    "**/.env",
    "**/.env.local",
    "**/.env.development",
    "**/.env.development.local",
    "**/.env.production",
    "**/.env.production.local",
    "**/.env.test",
    "**/.env.test.local",
    "**/*secret*",
    "**/*token*",
    "**/*credential*",
  ];
}

function normalizePolicyModes(value: unknown, fallback: PolicyMode[]): PolicyMode[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    throw new Error("workspace profile allowedPolicyModes must be an array");
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new Error("workspace profile allowedPolicyModes must contain strings");
    }
    return parsePolicyMode(item, "workspace profile allowedPolicyModes");
  });
}

function normalizeStringArray(value: unknown, fallback: string[], name: string): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}

function normalizeBackupPolicy(value: unknown): WorkspaceProfile["backupPolicy"] {
  if (value === undefined) return "manual";
  if (value !== "none" && value !== "manual" && value !== "snapshot") {
    throw new Error("workspace profile backupPolicy must be one of: none, manual, snapshot");
  }
  return value;
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32" ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase() : resolvedLeft === resolvedRight;
}

function defaultWorkspaceRoots(): string[] {
  if (process.platform !== "win32") {
    return [path.parse(process.cwd()).root || "/"];
  }

  const roots: string[] = [];
  const addRoot = (rootPath: string) => {
    const resolved = path.resolve(rootPath);
    if (!roots.some((existing) => samePath(existing, resolved))) {
      roots.push(resolved);
    }
  };

  for (let code = 65; code <= 90; code += 1) {
    const rootPath = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(rootPath)) {
        addRoot(rootPath);
      }
    } catch {
      // Some drive letters can be unavailable or slow to query. Ignore them.
    }
  }

  const currentRoot = path.parse(process.cwd()).root;
  if (currentRoot) {
    addRoot(currentRoot);
  }

  return roots.length ? roots : ["C:\\"];
}

function workspaceNameForRoot(rootPath: string, index: number): string {
  if (process.platform === "win32") {
    const drive = rootPath.match(/^([a-z]):\\/i)?.[1]?.toLowerCase();
    if (drive) return `drive-${drive}`;
  }
  return index === 0 ? "filesystem-root" : `filesystem-root-${index + 1}`;
}

function workspaceLabelForRoot(rootPath: string): string {
  if (process.platform === "win32") {
    return `Drive ${rootPath}`;
  }
  return `Filesystem root ${rootPath}`;
}

function readWorkspaceProfiles(maxPolicyMode: PolicyMode): WorkspaceProfile[] {
  const fallbackAllowedPolicyModes = policyModesUpTo(maxPolicyMode);
  const raw = process.env.GPT_FS_MCP_WORKSPACE_PROFILES_JSON;
  if (!raw) {
    return defaultWorkspaceRoots().map((rootPath, index) => ({
      allowedPolicyModes: fallbackAllowedPolicyModes,
      backupPolicy: "manual",
      label: workspaceLabelForRoot(rootPath),
      name: workspaceNameForRoot(rootPath, index),
      rootPath,
      secretDenyGlobs: defaultSecretDenyGlobs(),
    }));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GPT_FS_MCP_WORKSPACE_PROFILES_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("GPT_FS_MCP_WORKSPACE_PROFILES_JSON must be a non-empty array");
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`workspace profile at index ${index} must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name.trim()) {
      throw new Error(`workspace profile at index ${index} requires name`);
    }
    if (typeof record.rootPath !== "string" || !record.rootPath.trim()) {
      throw new Error(`workspace profile ${record.name} requires rootPath`);
    }
    return {
      allowedPolicyModes: normalizePolicyModes(record.allowedPolicyModes, fallbackAllowedPolicyModes),
      backupPolicy: normalizeBackupPolicy(record.backupPolicy),
      label: typeof record.label === "string" && record.label.trim() ? record.label : record.name,
      name: record.name,
      rootPath: path.resolve(record.rootPath),
      secretDenyGlobs: normalizeStringArray(record.secretDenyGlobs, defaultSecretDenyGlobs(), "workspace profile secretDenyGlobs"),
    };
  });
}

export function loadConfig(): AppConfig {
  const defaultCwd = process.env.GPT_FS_MCP_DEFAULT_CWD || path.join(os.homedir(), "Documents", "GitHub");
  const host = process.env.GPT_FS_MCP_HOST || "127.0.0.1";
  const port = readInteger("GPT_FS_MCP_PORT", 8789);
  const authRequired = readBoolean("AUTH_REQUIRED", true);
  const authRequirePkce = readBoolean("AUTH_REQUIRE_PKCE", true);
  const cloudflareTunnelEnabled = readBoolean("CLOUDFLARE_TUNNEL_ENABLED", false);
  const trustProxyHeaders = readBoolean("TRUST_PROXY_HEADERS", false);
  const maxOutputBytes = readInteger("GPT_FS_MCP_MAX_OUTPUT_BYTES", 200_000);
  const maxBodyBytes = readInteger("GPT_FS_MCP_MAX_BODY_BYTES", Math.ceil(maxOutputBytes * 1.5));
  const maxPolicyMode = parsePolicyMode(process.env.GPT_FS_MCP_MAX_POLICY_MODE || "destructive", "GPT_FS_MCP_MAX_POLICY_MODE");
  const enforceWorkspaceProfiles = readBoolean("GPT_FS_MCP_ENFORCE_WORKSPACE_PROFILES", true);
  const workspaceProfiles = readWorkspaceProfiles(maxPolicyMode);
  const minBodyBytes = Math.ceil(maxOutputBytes * 1.1);
  if (maxBodyBytes < minBodyBytes) {
    throw new Error("GPT_FS_MCP_MAX_BODY_BYTES must be at least 110% of GPT_FS_MCP_MAX_OUTPUT_BYTES");
  }
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://${host}:${port}`).replace(/\/+$/, "");
  const resourceUri = new URL("/mcp", publicBaseUrl).href;
  const publicHost = normalizeAllowedHost(new URL(publicBaseUrl).hostname);
  const allowedHosts = Array.from(
    new Set(["127.0.0.1", "localhost", "[::1]", normalizeAllowedHost(host), publicHost]),
  );

  if (!authRequired) {
    if (process.env.NODE_ENV && process.env.NODE_ENV !== "development") {
      throw new Error("AUTH_REQUIRED=false is allowed only when NODE_ENV is unset or development");
    }
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new Error("AUTH_REQUIRED=false requires GPT_FS_MCP_HOST to bind localhost only");
    }
    if (publicBaseUrl.startsWith("https://")) {
      throw new Error("AUTH_REQUIRED=false cannot use a public HTTPS PUBLIC_BASE_URL");
    }
    if (cloudflareTunnelEnabled) {
      throw new Error("AUTH_REQUIRED=false cannot run with CLOUDFLARE_TUNNEL_ENABLED=true");
    }
  } else {
    const url = new URL(publicBaseUrl);
    const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (!isLocalhost && url.protocol !== "https:") {
      throw new Error("AUTH_REQUIRED=true requires HTTPS PUBLIC_BASE_URL unless localhost");
    }
  }

  const defaultOauthScopes = readScopeList("DEFAULT_OAUTH_SCOPES");
  const effectiveDefaultOauthScopes = defaultOauthScopes.length
    ? defaultOauthScopes
    : [...ALL_SCOPES];
  const invalidDefaultScopes = effectiveDefaultOauthScopes.filter((scope) => !ALL_SCOPES.includes(scope as Scope));
  if (invalidDefaultScopes.length) {
    throw new Error(`DEFAULT_OAUTH_SCOPES contains invalid scopes: ${invalidDefaultScopes.join(" ")}`);
  }

  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
  const oauthClientId = process.env.OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.OAUTH_CLIENT_SECRET;
  const oauthRedirectUris = readCommaList("OAUTH_REDIRECT_URIS");
  const allowedGithubLogins = readCommaList("ALLOWED_GITHUB_LOGINS").map((login) => login.toLowerCase());

  for (const redirectUri of oauthRedirectUris) {
    validateRedirectUri(redirectUri);
  }

  if (authRequired) {
    requireEnv(githubClientId, "GITHUB_CLIENT_ID");
    requireEnv(githubClientSecret, "GITHUB_CLIENT_SECRET");
    requireEnv(oauthClientId, "OAUTH_CLIENT_ID");
    requireEnv(oauthClientSecret, "OAUTH_CLIENT_SECRET");
    if (!oauthRedirectUris.length) {
      throw new Error("OAUTH_REDIRECT_URIS is required when AUTH_REQUIRED=true");
    }
    if (!allowedGithubLogins.length) {
      throw new Error("ALLOWED_GITHUB_LOGINS is required when AUTH_REQUIRED=true");
    }
  }

  return {
    allowedHosts,
    allowedGithubLogins,
    authRateLimitMaxBuckets: readInteger("AUTH_RATE_LIMIT_MAX_BUCKETS", 10_000),
    authRateLimitMax: readInteger("AUTH_RATE_LIMIT_MAX", 60),
    authRateLimitWindowMs: readInteger("AUTH_RATE_LIMIT_WINDOW_MS", 60_000),
    authRequired,
    authRequirePkce,
    authStoreCleanupIntervalMs: readInteger("AUTH_STORE_CLEANUP_INTERVAL_MS", 60_000),
    authStoreMaxAuthCodes: readInteger("AUTH_STORE_MAX_AUTH_CODES", 1_000),
    authStoreMaxPending: readInteger("AUTH_STORE_MAX_PENDING", 1_000),
    authStoreMaxTokens: readInteger("AUTH_STORE_MAX_TOKENS", 100),
    browserSessionIdleMs: readInteger("GPT_FS_MCP_BROWSER_SESSION_IDLE_MS", 30 * 60 * 1000),
    cloudflareTunnelEnabled,
    defaultCwd,
    defaultOauthScopes: effectiveDefaultOauthScopes,
    devIdentityLogin: process.env.DEV_IDENTITY_LOGIN || "local-dev",
    enforceWorkspaceProfiles,
    exposeRuntimeDebug: readBoolean("EXPOSE_RUNTIME_DEBUG", false),
    githubClientId,
    githubClientSecret,
    host,
    journalPath: process.env.GPT_FS_MCP_JOURNAL_PATH || path.join(process.cwd(), "data", "journal.jsonl"),
    backupDir: process.env.GPT_FS_MCP_BACKUP_DIR || path.join(process.cwd(), "data", "backups"),
    maxBrowserLogEntries: readInteger("GPT_FS_MCP_MAX_BROWSER_LOG_ENTRIES", 200),
    maxBrowserScreenshotFiles: readInteger("GPT_FS_MCP_MAX_BROWSER_SCREENSHOT_FILES", 100),
    maxBrowserScreenshotBytes: readInteger("GPT_FS_MCP_MAX_BROWSER_SCREENSHOT_BYTES", 10_000_000),
    maxBrowserSessions: readInteger("GPT_FS_MCP_MAX_BROWSER_SESSIONS", 5),
    maxBodyBytes,
    maxBackupBytes: readInteger("GPT_FS_MCP_MAX_BACKUP_BYTES", 5_000_000),
    maxOutputBytes,
    maxPolicyMode,
    maxScreenshotAreaPixels: readInteger("GPT_FS_MCP_MAX_SCREENSHOT_AREA_PIXELS", 33_000_000),
    maxScreenshotBytes: readInteger("GPT_FS_MCP_MAX_SCREENSHOT_BYTES", 100_000_000),
    maxScreenshotDimension: readInteger("GPT_FS_MCP_MAX_SCREENSHOT_DIMENSION", 8192),
    maxScreenshotFiles: readInteger("GPT_FS_MCP_MAX_SCREENSHOT_FILES", 100),
    oauthClientId,
    oauthClientSecret,
    oauthRedirectUris,
    port,
    protectedResourceMetadataUrl: new URL("/.well-known/oauth-protected-resource", publicBaseUrl).href,
    publicBaseUrl,
    processPolicy: readCommandPolicy("GPT_FS_MCP_PROCESS_POLICY", "full"),
    resourceUri,
    shellTimeoutMs: readInteger("GPT_FS_MCP_SHELL_TIMEOUT_MS", 120_000),
    shellPolicy: readCommandPolicy("GPT_FS_MCP_SHELL_POLICY", "full"),
    trustProxyHeaders,
    workspaceProfiles,
  };
}
