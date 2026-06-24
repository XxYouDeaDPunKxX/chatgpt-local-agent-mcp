import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chromium, firefox, webkit } from "playwright";
import type { Browser, BrowserContext, BrowserType, ConsoleMessage, Page, Request, Response } from "playwright";
import { z } from "zod";
import { errorText, jsonText } from "../format.js";
import { FileEffect, redactArgs, runJournaledOperation, sha256Hex } from "../journal.js";
import { McpRuntime } from "../mcp.js";
import { requireScope } from "../runtime.js";
import { SCOPES } from "../scopes.js";
import { INSTRUCTION_SAFETY_NOTE } from "../source-trust.js";

type BrowserName = "chromium" | "firefox" | "webkit";

type BrowserLogEntry = {
  location?: string;
  text: string;
  textTruncated?: boolean;
  timestamp: string;
  type: string;
};

type BrowserNetworkEntry = {
  error?: string;
  errorTruncated?: boolean;
  method: string;
  status?: number;
  timestamp: string;
  type: "response" | "requestfailed";
  url: string;
  urlTruncated?: boolean;
};

type BrowserSession = {
  allowedHostnames: string[];
  browser: Browser;
  browserName: BrowserName;
  console: BrowserLogEntry[];
  context: BrowserContext;
  cdpEndpoint?: string;
  createdAt: string;
  headless: boolean;
  id: string;
  lastUsedAt: number;
  listenedPages: WeakSet<Page>;
  network: BrowserNetworkEntry[];
  page: Page;
  source: "isolated" | "cdp";
};

const browserSessions = new Map<string, BrowserSession>();
let shutdownHandlersInstalled = false;

function browserDataDir(runtime: McpRuntime): string {
  return path.join(path.dirname(runtime.config.journalPath), "browser");
}

function browserType(browserName: BrowserName): BrowserType {
  if (browserName === "firefox") return firefox;
  if (browserName === "webkit") return webkit;
  return chromium;
}

function pushBounded<T>(items: T[], item: T, maxItems: number): void {
  items.push(item);
  while (items.length > maxItems) {
    items.shift();
  }
}

async function closeBrowserSession(session: BrowserSession): Promise<void> {
  await session.browser.close().catch(() => undefined);
}

async function closeAllBrowserSessions(): Promise<void> {
  const sessions = [...browserSessions.values()];
  browserSessions.clear();
  await Promise.all(sessions.map((session) => closeBrowserSession(session)));
}

function installBrowserShutdownHandlers(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  const closeAndExit = (exitCode: number) => {
    void closeAllBrowserSessions().finally(() => process.exit(exitCode));
  };
  process.once("SIGINT", () => closeAndExit(130));
  process.once("SIGTERM", () => closeAndExit(143));
  process.once("beforeExit", () => {
    void closeAllBrowserSessions();
  });
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return { text: value, truncated: false };
  }
  return {
    text: buffer.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/(access[_-]?token|auth|code|credential|key|password|secret|session|token)/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    if (url.username) url.username = "[REDACTED]";
    if (url.password) url.password = "[REDACTED]";
    return url.href;
  } catch {
    return value;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
}

function validateCdpEndpoint(endpointUrl: string, allowRemote: boolean | undefined, confirm: boolean | undefined): void {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    throw new Error(`Invalid CDP endpoint URL: ${endpointUrl}`);
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error("CDP endpoint must use http, https, ws, or wss");
  }
  if (!confirm) {
    throw new Error("CDP endpoint attach requires confirm=true");
  }
  if (!isLoopbackHostname(parsed.hostname) && (!allowRemote || !confirm)) {
    throw new Error("Remote CDP endpoint requires allowRemote=true and confirm=true");
  }
}

function validateBrowserUrl(url: string, allowNonHttp: boolean | undefined, confirm: boolean | undefined): void {
  const parsed = new URL(url);
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return;
  }
  if (!allowNonHttp || !confirm) {
    throw new Error("Non-http browser URLs require allowNonHttp=true and confirm=true");
  }
}

function normalizeAllowedHostnames(values: string[] | undefined): string[] {
  const normalized = (values || [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value).hostname.toLowerCase();
      } catch {
        return value.replace(/^\.+/, "");
      }
    })
    .filter((value) => value && !value.includes("/") && !value.includes(":"));
  return [...new Set(normalized)];
}

function isBlankBrowserUrl(url: string): boolean {
  return url === "about:blank" || url === "";
}

function hostnameFromBrowserUrl(url: string): string | undefined {
  if (isBlankBrowserUrl(url)) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostnameAllowed(hostname: string, allowedHostnames: string[]): boolean {
  return allowedHostnames.some((allowed) => {
    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(2);
      return hostname.endsWith(`.${suffix}`) && hostname !== suffix;
    }
    return hostname === allowed;
  });
}

function assertUrlWithinAllowedHostnames(url: string, allowedHostnames: string[], label: string): void {
  if (!allowedHostnames.length || isBlankBrowserUrl(url)) return;
  const hostname = hostnameFromBrowserUrl(url);
  if (!hostname || !hostnameAllowed(hostname, allowedHostnames)) {
    throw new Error(`${label} is outside browser session allowedHostnames: ${redactUrl(url)}`);
  }
}

async function assertActivePageInScope(session: BrowserSession, label: string): Promise<void> {
  assertUrlWithinAllowedHostnames(session.page.url(), session.allowedHostnames, label);
}

function redactBrowserText(value: string): string {
  return redactUrl(value)
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(
      /(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|AUTH|SESSION|CODE)[A-Z0-9_]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&"'`]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:access[_-]?token|auth|code|credential|key|password|secret|session|token)=)(?:"[^"]*"|'[^']*'|[^\s&"'`]+)/gi,
      "$1[REDACTED]",
    );
}

function requireRawConfirm(raw: boolean | undefined, confirm: boolean | undefined, tool: string): void {
  if (raw && !confirm) {
    throw new Error(`${tool} raw output requires confirm=true`);
  }
}

function requireCdpActionConfirm(session: BrowserSession, confirm: boolean | undefined, tool: string): void {
  if (session.source === "cdp" && !confirm) {
    throw new Error(`${tool} on an existing-profile CDP session requires confirm=true`);
  }
}

function outputBudget(runtime: McpRuntime, maxBytes?: number): number {
  return Math.min(maxBytes || runtime.config.maxOutputBytes, runtime.config.maxOutputBytes);
}

function redactedInputLength(value: string): { redacted: string; length: number } {
  return { length: value.length, redacted: "[REDACTED]" };
}

async function safePageTitle(page: Page, raw = false): Promise<string> {
  const title = await page.title().catch(() => "");
  return raw ? title : redactBrowserText(title);
}

function consoleEntry(message: ConsoleMessage): BrowserLogEntry {
  const location = message.location();
  return {
    location: location.url ? `${location.url}:${location.lineNumber}:${location.columnNumber}` : undefined,
    text: message.text(),
    timestamp: new Date().toISOString(),
    type: message.type(),
  };
}

function responseEntry(response: Response): BrowserNetworkEntry {
  const request = response.request();
  return {
    method: request.method(),
    status: response.status(),
    timestamp: new Date().toISOString(),
    type: "response",
    url: response.url(),
  };
}

function requestFailedEntry(request: Request): BrowserNetworkEntry {
  return {
    error: request.failure()?.errorText,
    method: request.method(),
    timestamp: new Date().toISOString(),
    type: "requestfailed",
    url: request.url(),
  };
}

function attachPageListeners(runtime: McpRuntime, session: BrowserSession): void {
  if (session.listenedPages.has(session.page)) {
    return;
  }
  session.listenedPages.add(session.page);
  session.page.on("console", (message) => pushBounded(session.console, consoleEntry(message), runtime.config.maxBrowserLogEntries));
  session.page.on("response", (response) => pushBounded(session.network, responseEntry(response), runtime.config.maxBrowserLogEntries));
  session.page.on("requestfailed", (request) => pushBounded(session.network, requestFailedEntry(request), runtime.config.maxBrowserLogEntries));
}

async function appendBrowserJournal({
  argsRedacted,
  error,
  outcome,
  runtime,
  startedAt,
  tool,
}: {
  argsRedacted: unknown;
  error?: unknown;
  outcome: "success" | "error";
  runtime: McpRuntime;
  startedAt: number;
  tool: string;
}): Promise<void> {
  await runtime.journal.appendDurable({
    argsRedacted,
    durationMs: Date.now() - startedAt,
    error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
    id: runtime.context.requestId,
    identity: runtime.context.identity,
    outcome,
    requiredScope: SCOPES.browser,
    timestamp: new Date().toISOString(),
    tool,
  });
}

async function cleanupBrowserSessions(runtime: McpRuntime): Promise<void> {
  const now = Date.now();
  for (const [sessionId, session] of browserSessions.entries()) {
    if (now - session.lastUsedAt > runtime.config.browserSessionIdleMs) {
      browserSessions.delete(sessionId);
      await closeBrowserSession(session);
    }
  }

  while (browserSessions.size > runtime.config.maxBrowserSessions) {
    const oldest = [...browserSessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!oldest) break;
    browserSessions.delete(oldest.id);
    await closeBrowserSession(oldest);
  }
}

async function getBrowserSession(runtime: McpRuntime, sessionId: string): Promise<BrowserSession> {
  await cleanupBrowserSessions(runtime);
  const session = browserSessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown browser session: ${sessionId}`);
  }
  session.lastUsedAt = Date.now();
  return session;
}

function sessionSummary(session: BrowserSession) {
  return {
    allowedHostnames: session.allowedHostnames,
    browser: session.browserName,
    cdpEndpoint: session.cdpEndpoint,
    createdAt: session.createdAt,
    headless: session.headless,
    lastUsedAt: new Date(session.lastUsedAt).toISOString(),
    sessionId: session.id,
    source: session.source,
    title: "",
    url: "",
  };
}

async function pageSummary(session: BrowserSession) {
  return {
    allowedHostnames: session.allowedHostnames,
    browser: session.browserName,
    cdpEndpoint: session.cdpEndpoint,
    createdAt: session.createdAt,
    headless: session.headless,
    lastUsedAt: new Date(session.lastUsedAt).toISOString(),
    sessionId: session.id,
    source: session.source,
    title: await safePageTitle(session.page),
    url: redactUrl(session.page.url()),
  };
}

async function browserPages(session: BrowserSession): Promise<Page[]> {
  const pages = session.browser.contexts().flatMap((context) => context.pages());
  return pages.length ? pages : [session.page];
}

async function pageList(session: BrowserSession, raw: boolean): Promise<Array<{ active: boolean; outOfScope: boolean; pageIndex: number; title: string; url: string }>> {
  const pages = await browserPages(session);
  return Promise.all(
    pages.map(async (page, pageIndex) => ({
      active: page === session.page,
      outOfScope:
        !!session.allowedHostnames.length &&
        !isBlankBrowserUrl(page.url()) &&
        !hostnameAllowed(hostnameFromBrowserUrl(page.url()) || "", session.allowedHostnames),
      pageIndex,
      title: await safePageTitle(page, raw),
      url: raw ? page.url() : redactUrl(page.url()),
    })),
  );
}

export async function browserSessionDashboardSummaries(): Promise<
  Array<{
    allowedHostnames: string[];
    browser: BrowserName;
    cdpEndpoint?: string;
    createdAt: string;
    headless: boolean;
    lastUsedAt: string;
    pageCount: number;
    sessionId: string;
    source: "isolated" | "cdp";
    title: string;
    url: string;
  }>
> {
  const summaries = [];
  for (const session of browserSessions.values()) {
    summaries.push({
      allowedHostnames: session.allowedHostnames,
      browser: session.browserName,
      cdpEndpoint: session.cdpEndpoint,
      createdAt: session.createdAt,
      headless: session.headless,
      lastUsedAt: new Date(session.lastUsedAt).toISOString(),
      pageCount: (await browserPages(session)).length,
      sessionId: session.id,
      source: session.source,
      title: await safePageTitle(session.page),
      url: redactUrl(session.page.url()),
    });
  }
  return summaries;
}

export async function closeBrowserSessionForDashboard(sessionId: string): Promise<boolean> {
  const session = browserSessions.get(sessionId);
  if (!session) return false;
  browserSessions.delete(sessionId);
  await closeBrowserSession(session);
  return true;
}

async function closeOutOfScopeInactivePages(session: BrowserSession): Promise<Array<{ pageIndex: number; title: string; url: string }>> {
  if (!session.allowedHostnames.length) return [];
  const pages = await browserPages(session);
  const closed: Array<{ pageIndex: number; title: string; url: string }> = [];
  await Promise.all(
    pages.map(async (page, pageIndex) => {
      if (page === session.page || isBlankBrowserUrl(page.url())) return;
      const hostname = hostnameFromBrowserUrl(page.url());
      if (hostname && hostnameAllowed(hostname, session.allowedHostnames)) return;
      closed.push({
        pageIndex,
        title: await safePageTitle(page),
        url: redactUrl(page.url()),
      });
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
    }),
  );
  return closed.sort((a, b) => a.pageIndex - b.pageIndex);
}

async function runScopedBrowserAction<T>(
  session: BrowserSession,
  label: string,
  action: () => Promise<T>,
  options: { watchPopup?: boolean } = {},
): Promise<{ closedOutOfScopePages: Array<{ pageIndex: number; title: string; url: string }>; result: T }> {
  await assertActivePageInScope(session, `${label} before action`);
  const popupPromise = options.watchPopup
    ? session.page.waitForEvent("popup", { timeout: 1_000 }).catch(() => undefined)
    : undefined;
  const result = await action();
  if (popupPromise) {
    await popupPromise;
    await session.page.waitForTimeout(100).catch(() => undefined);
  }
  const closedOutOfScopePages = await closeOutOfScopeInactivePages(session);
  await assertActivePageInScope(session, `${label} after action`);
  return { closedOutOfScopePages, result };
}

async function locatorFor(page: Page, args: { ariaRef?: string; selector?: string }) {
  if (args.ariaRef) {
    return page.locator(`aria-ref=${args.ariaRef}`);
  }
  if (!args.selector) {
    throw new Error("selector or ariaRef is required");
  }
  return page.locator(args.selector);
}

function browserScreenshotBase64Bytes(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

async function screenshotMetadata(filePath: string): Promise<{ hash: string; size: number }> {
  const content = await fs.readFile(filePath);
  return {
    hash: sha256Hex(content),
    size: content.byteLength,
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function browserScreenshotEffects(filePath: string, directory: string, cleanupEffects: FileEffect[]): Promise<FileEffect[]> {
  const effects: FileEffect[] = [];
  if (await pathExists(directory)) {
    effects.push({ operation: "mkdir", path: directory });
  }
  if (await pathExists(filePath)) {
    const metadata = await screenshotMetadata(filePath);
    effects.push({
      afterHash: metadata.hash,
      bytesAfter: metadata.size,
      operation: "create",
      path: filePath,
    });
  }
  return [...cleanupEffects, ...effects];
}

async function plannedBrowserScreenshotEffects(filePath: string, directory: string): Promise<FileEffect[]> {
  const effects: FileEffect[] = [];
  if (!(await pathExists(directory))) {
    effects.push({ operation: "mkdir", path: directory });
  }
  effects.push({ operation: "create", path: filePath });
  return effects;
}

async function cleanupBrowserScreenshots(runtime: McpRuntime, directory: string, keepPath: string): Promise<FileEffect[]> {
  let entries: { filePath: string; mtimeMs: number; size: number }[];
  try {
    const dirEntries = await fs.readdir(directory, { withFileTypes: true });
    entries = await Promise.all(
      dirEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
        .map(async (entry) => {
          const filePath = path.join(directory, entry.name);
          const stats = await fs.stat(filePath);
          return { filePath, mtimeMs: stats.mtimeMs, size: stats.size };
        }),
    );
  } catch {
    return [];
  }

  const stale = entries
    .filter((entry) => path.resolve(entry.filePath) !== path.resolve(keepPath))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(Math.max(0, runtime.config.maxBrowserScreenshotFiles - 1));

  const effects: FileEffect[] = [];
  for (const entry of stale) {
    await fs.unlink(entry.filePath).catch(() => undefined);
    effects.push({
      bytesBefore: entry.size,
      operation: "delete",
      path: entry.filePath,
    });
  }
  return effects;
}

function fitEntriesToBudget<T extends Record<string, unknown>>(
  entries: T[],
  maxBytes: number,
): { entries: T[]; totalBytes: number; truncated: boolean } {
  const result: T[] = [];
  let totalBytes = 2;
  for (const entry of entries) {
    const entryBytes = byteLength(JSON.stringify(entry));
    if (totalBytes + entryBytes + 1 > maxBytes) {
      return { entries: result, totalBytes, truncated: true };
    }
    result.push(entry);
    totalBytes += entryBytes + 1;
  }
  return { entries: result, totalBytes, truncated: false };
}

function formatConsoleEntry(entry: BrowserLogEntry, raw: boolean, maxFieldBytes: number): BrowserLogEntry {
  const text = raw ? entry.text : redactBrowserText(entry.text);
  const cappedText = truncateUtf8(text, maxFieldBytes);
  return {
    location: entry.location ? (raw ? entry.location : redactUrl(entry.location)) : undefined,
    text: cappedText.text,
    textTruncated: cappedText.truncated || entry.textTruncated,
    timestamp: entry.timestamp,
    type: entry.type,
  };
}

function formatNetworkEntry(entry: BrowserNetworkEntry, raw: boolean, maxFieldBytes: number): BrowserNetworkEntry {
  const url = raw ? entry.url : redactUrl(entry.url);
  const cappedUrl = truncateUtf8(url, maxFieldBytes);
  const error = entry.error ? (raw ? entry.error : redactBrowserText(entry.error)) : undefined;
  const cappedError = error ? truncateUtf8(error, maxFieldBytes) : undefined;
  return {
    error: cappedError?.text,
    errorTruncated: cappedError?.truncated || entry.errorTruncated,
    method: entry.method,
    status: entry.status,
    timestamp: entry.timestamp,
    type: entry.type,
    url: cappedUrl.text,
    urlTruncated: cappedUrl.truncated || entry.urlTruncated,
  };
}

const sessionOutputSchema = {
  allowedHostnames: z.array(z.string()),
  browser: z.enum(["chromium", "firefox", "webkit"]),
  cdpEndpoint: z.string().optional(),
  createdAt: z.string(),
  headless: z.boolean(),
  lastUsedAt: z.string(),
  sessionId: z.string(),
  source: z.enum(["isolated", "cdp"]),
  title: z.string(),
  url: z.string(),
};

const timeoutSchema = z.number().int().positive().max(120_000).optional().default(30_000);

export function registerBrowserCdpConnectTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_cdp_connect",
    {
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description:
        "Escape hatch for attaching to an existing Chromium-based browser/profile through Chrome DevTools Protocol. Prefer browser_session_create for isolated browsing unless you explicitly need an already logged-in profile or existing tab state.",
      inputSchema: {
        allowRemote: z.boolean().optional().default(false),
        confirm: z.boolean().optional().default(false),
        endpointUrl: z.string().url().optional().default("http://127.0.0.1:9222"),
        allowedHostnames: z
          .array(z.string().min(1))
          .optional()
          .default([])
          .describe("Immutable host allowlist for this CDP session. Supports exact hosts and *.example.com wildcards."),
        expectedHostnames: z.array(z.string().min(1)).optional().default([]).describe("Deprecated alias for allowedHostnames."),
        isolatedBrowserBypassReason: z.string().min(1).describe("Why an isolated browser_session_create session is not sufficient."),
        pageIndex: z.number().int().min(0).optional().default(0),
        purpose: z.string().min(1).describe("Short operational purpose for attaching to an existing browser profile."),
        timeoutMs: timeoutSchema,
      },
      outputSchema: {
        auditQuality: z.enum(["sensitive"]),
        ...sessionOutputSchema,
        allowedHostnames: z.array(z.string()),
        isolatedBrowserBypassReason: z.string(),
        pages: z.array(z.object({ active: z.boolean(), outOfScope: z.boolean(), pageIndex: z.number(), title: z.string(), url: z.string() })),
        purpose: z.string(),
      },
      title: "Connect Browser CDP",
    },
    async ({ allowRemote, allowedHostnames, confirm, endpointUrl, expectedHostnames, isolatedBrowserBypassReason, pageIndex, purpose, timeoutMs }) => {
      try {
        requireScope(runtime.context, SCOPES.browser);
        installBrowserShutdownHandlers();
        validateCdpEndpoint(endpointUrl, allowRemote, confirm);
        await cleanupBrowserSessions(runtime);
        if (browserSessions.size >= runtime.config.maxBrowserSessions) {
          throw new Error(`Too many browser sessions: ${browserSessions.size} >= ${runtime.config.maxBrowserSessions}`);
        }
        const sessionAllowedHostnames = normalizeAllowedHostnames(allowedHostnames.length ? allowedHostnames : expectedHostnames);
        const session = await runJournaledOperation<BrowserSession>({
          argsRedacted: redactArgs({
            allowRemote,
            allowedHostnames: sessionAllowedHostnames,
            confirm,
            endpointUrl: redactUrl(endpointUrl),
            expectedHostnames,
            isolatedBrowserBypassReason,
            pageIndex,
            purpose,
            timeoutMs,
          }),
          effect: async () => {
            const connected = await chromium.connectOverCDP(endpointUrl, { isLocal: isLoopbackHostname(new URL(endpointUrl).hostname), noDefaults: true, timeout: timeoutMs });
            try {
              const pages = connected.contexts().flatMap((context) => context.pages());
              if (!pages.length) {
                throw new Error("CDP browser has no contexts");
              }
              const page = pages[pageIndex];
              if (!page) {
                throw new Error(`CDP pageIndex out of range: ${pageIndex}`);
              }
              assertUrlWithinAllowedHostnames(page.url(), sessionAllowedHostnames, "Selected CDP page");
              const context = page.context();
              const record: BrowserSession = {
                allowedHostnames: sessionAllowedHostnames,
                browser: connected,
                browserName: "chromium",
                cdpEndpoint: redactUrl(endpointUrl),
                console: [],
                context,
                createdAt: new Date().toISOString(),
                headless: false,
                id: crypto.randomUUID(),
                lastUsedAt: Date.now(),
                listenedPages: new WeakSet<Page>(),
                network: [],
                page,
                source: "cdp",
              };
              attachPageListeners(runtime, record);
              browserSessions.set(record.id, record);
              return record;
            } catch (error) {
              await connected.close().catch(() => undefined);
              throw error;
            }
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.browser,
          requestId: runtime.context.requestId,
          tool: "browser_cdp_connect",
        });
        return jsonText({
          auditQuality: "sensitive",
          ...(await pageSummary(session)),
          allowedHostnames: session.allowedHostnames,
          isolatedBrowserBypassReason,
          pages: await pageList(session, false),
          purpose,
        });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerBrowserSessionCreateTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_session_create",
    {
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description:
        "Preferred browser entry point for web work. Creates an isolated local Playwright browser session; use this instead of browser_cdp_connect unless an existing logged-in profile is required.",
      inputSchema: {
        allowNonHttp: z.boolean().optional().default(false),
        allowedHostnames: z
          .array(z.string().min(1))
          .optional()
          .default([])
          .describe("Immutable host allowlist for this browser session. Supports exact hosts and *.example.com wildcards."),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().default("chromium"),
        confirm: z.boolean().optional().default(false),
        headless: z.boolean().optional().default(false),
        timeoutMs: timeoutSchema,
        url: z.string().url().optional(),
        viewportHeight: z.number().int().positive().max(4320).optional().default(900),
        viewportWidth: z.number().int().positive().max(7680).optional().default(1440),
      },
      outputSchema: sessionOutputSchema,
      title: "Create Browser Session",
    },
    async ({ allowNonHttp, allowedHostnames, browser, confirm, headless, timeoutMs, url, viewportHeight, viewportWidth }) => {
      try {
        requireScope(runtime.context, SCOPES.browser);
        if (url) validateBrowserUrl(url, allowNonHttp, confirm);
        const sessionAllowedHostnames = normalizeAllowedHostnames(allowedHostnames);
        if (url) assertUrlWithinAllowedHostnames(url, sessionAllowedHostnames, "Initial browser URL");
        installBrowserShutdownHandlers();
        await cleanupBrowserSessions(runtime);
        if (browserSessions.size >= runtime.config.maxBrowserSessions) {
          throw new Error(`Too many browser sessions: ${browserSessions.size} >= ${runtime.config.maxBrowserSessions}`);
        }
        const session = await runJournaledOperation<BrowserSession>({
          argsRedacted: redactArgs({ allowNonHttp, allowedHostnames: sessionAllowedHostnames, browser, confirm, headless, timeoutMs, url: url ? redactUrl(url) : undefined, viewportHeight, viewportWidth }),
          effect: async () => {
            let launched: Browser | undefined;
            try {
              launched = await browserType(browser).launch({ headless, timeout: timeoutMs });
              const context = await launched.newContext({ viewport: { height: viewportHeight, width: viewportWidth } });
              context.setDefaultTimeout(timeoutMs);
              const page = await context.newPage();
              const record: BrowserSession = {
                allowedHostnames: sessionAllowedHostnames,
                browser: launched,
                browserName: browser,
                console: [],
                context,
                createdAt: new Date().toISOString(),
                headless,
                id: crypto.randomUUID(),
                lastUsedAt: Date.now(),
                listenedPages: new WeakSet<Page>(),
                network: [],
                page,
                source: "isolated",
              };
              attachPageListeners(runtime, record);
              if (url) {
                await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
                await assertActivePageInScope(record, "Initial browser final URL");
              }
              browserSessions.set(record.id, record);
              return record;
            } catch (error) {
              await launched?.close().catch(() => undefined);
              throw error;
            }
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.browser,
          requestId: runtime.context.requestId,
          tool: "browser_session_create",
        });
        return jsonText(await pageSummary(session));
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerBrowserSessionListTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_session_list",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
      description: "List active local Playwright browser sessions.",
      inputSchema: {},
      outputSchema: { sessions: z.array(z.object(sessionOutputSchema)) },
      title: "List Browser Sessions",
    },
    async () => {
      const startedAt = Date.now();
      try {
        requireScope(runtime.context, SCOPES.browser);
        await cleanupBrowserSessions(runtime);
        const sessions = [];
        for (const session of browserSessions.values()) {
          sessions.push(await pageSummary(session));
        }
        await appendBrowserJournal({
          argsRedacted: redactArgs({}),
          outcome: "success",
          runtime,
          startedAt,
          tool: "browser_session_list",
        });
        return jsonText({ sessions });
      } catch (error) {
        await appendBrowserJournal({
          argsRedacted: redactArgs({}),
          error,
          outcome: "error",
          runtime,
          startedAt,
          tool: "browser_session_list",
        });
        return errorText(error);
      }
    },
  );
}

export function registerBrowserSessionCloseTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_session_close",
    {
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
      description: "Close a local Playwright browser session and release its browser process.",
      inputSchema: { sessionId: z.string().uuid() },
      outputSchema: { closed: z.boolean(), sessionId: z.string() },
      title: "Close Browser Session",
    },
    async ({ sessionId }) => {
      try {
        requireScope(runtime.context, SCOPES.browser);
        const session = await getBrowserSession(runtime, sessionId);
        await runJournaledOperation({
          argsRedacted: redactArgs({ sessionId }),
          effect: async () => {
            browserSessions.delete(sessionId);
            await session.browser.close();
            return { closed: true, sessionId };
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.browser,
          requestId: runtime.context.requestId,
          tool: "browser_session_close",
        });
        return jsonText({ closed: true, sessionId });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerBrowserPageListTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_page_list",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
      description: "List pages/tabs available inside a browser session.",
      inputSchema: {
        confirm: z.boolean().optional().default(false),
        raw: z.boolean().optional().default(false),
        sessionId: z.string().uuid(),
      },
      outputSchema: { pages: z.array(z.object({ active: z.boolean(), outOfScope: z.boolean(), pageIndex: z.number(), title: z.string(), url: z.string() })), raw: z.boolean(), redacted: z.boolean(), sessionId: z.string() },
      title: "List Browser Pages",
    },
    async ({ confirm, raw, sessionId }) => {
      const startedAt = Date.now();
      const argsRedacted = redactArgs({ confirm, raw, sessionId });
      try {
        requireScope(runtime.context, SCOPES.browser);
        requireRawConfirm(raw, confirm, "browser_page_list");
        const session = await getBrowserSession(runtime, sessionId);
        const pages = await pageList(session, raw);
        await appendBrowserJournal({
          argsRedacted,
          outcome: "success",
          runtime,
          startedAt,
          tool: "browser_page_list",
        });
        return jsonText({ pages, raw, redacted: !raw, sessionId });
      } catch (error) {
        await appendBrowserJournal({
          argsRedacted,
          error,
          outcome: "error",
          runtime,
          startedAt,
          tool: "browser_page_list",
        });
        return errorText(error);
      }
    },
  );
}

export function registerBrowserPageSelectTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_page_select",
    {
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
      description: "Select the active page/tab inside a browser session by pageIndex from browser_page_list.",
      inputSchema: { pageIndex: z.number().int().min(0), sessionId: z.string().uuid() },
      outputSchema: sessionOutputSchema,
      title: "Select Browser Page",
    },
    async ({ pageIndex, sessionId }) => {
      try {
        requireScope(runtime.context, SCOPES.browser);
        const session = await getBrowserSession(runtime, sessionId);
        const pages = await browserPages(session);
        const page = pages[pageIndex];
        if (!page) {
          throw new Error(`pageIndex out of range: ${pageIndex}`);
        }
        if (session.allowedHostnames.length) {
          try {
            assertUrlWithinAllowedHostnames(page.url(), session.allowedHostnames, "Selected browser page");
          } catch (error) {
            if (page !== session.page) {
              await page.close({ runBeforeUnload: false }).catch(() => undefined);
            }
            throw error;
          }
        }
        await runJournaledOperation({
          argsRedacted: redactArgs({ pageIndex, sessionId }),
          effect: async () => {
            session.page = page;
            session.context = page.context();
            attachPageListeners(runtime, session);
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.browser,
          requestId: runtime.context.requestId,
          tool: "browser_page_select",
        });
        return jsonText(await pageSummary(session));
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerBrowserNavigateTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_navigate",
    {
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description: "Navigate a browser session to a URL.",
      inputSchema: {
        allowNonHttp: z.boolean().optional().default(false),
        confirm: z.boolean().optional().default(false),
        sessionId: z.string().uuid(),
        timeoutMs: timeoutSchema,
        url: z.string().url(),
        waitUntil: z.enum(["commit", "domcontentloaded", "load", "networkidle"]).optional().default("domcontentloaded"),
      },
      outputSchema: {
        ...sessionOutputSchema,
        closedOutOfScopePages: z.array(z.object({ pageIndex: z.number(), title: z.string(), url: z.string() })),
        status: z.number().optional(),
      },
      title: "Navigate Browser",
    },
    async ({ allowNonHttp, confirm, sessionId, timeoutMs, url, waitUntil }) => {
      try {
        requireScope(runtime.context, SCOPES.browser);
        validateBrowserUrl(url, allowNonHttp, confirm);
        const session = await getBrowserSession(runtime, sessionId);
        assertUrlWithinAllowedHostnames(url, session.allowedHostnames, "Browser navigation target");
        const result = await runJournaledOperation<{ closedOutOfScopePages: Array<{ pageIndex: number; title: string; url: string }>; response: Response | null }>({
          argsRedacted: redactArgs({ allowNonHttp, confirm, sessionId, timeoutMs, url: redactUrl(url), waitUntil }),
          effect: async () => {
            const response = await session.page.goto(url, { timeout: timeoutMs, waitUntil });
            await assertActivePageInScope(session, "Browser navigation final URL");
            const closedOutOfScopePages = await closeOutOfScopeInactivePages(session);
            return { closedOutOfScopePages, response };
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.browser,
          requestId: runtime.context.requestId,
          tool: "browser_navigate",
        });
        return jsonText({ ...(await pageSummary(session)), closedOutOfScopePages: result.closedOutOfScopePages, status: result.response?.status() });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerBrowserSnapshotTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_snapshot",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
      description:
        "Preferred structured read of a web page. Return an ARIA snapshot optimized for AI use; use this before element interactions and prefer it over screenshots unless pixels/layout must be inspected.",
      inputSchema: {
        boxes: z.boolean().optional().default(false),
        confirm: z.boolean().optional().default(false),
        depth: z.number().int().positive().max(20).optional().default(8),
        maxBytes: z.number().int().positive().max(1_000_000).optional(),
        raw: z.boolean().optional().default(false),
        sessionId: z.string().uuid(),
      },
      outputSchema: {
        ariaSnapshot: z.string(),
        instructionSafety: z.string(),
        raw: z.boolean(),
        redacted: z.boolean(),
        sessionId: z.string(),
        sourceTrust: z.enum(["untrusted_external_content"]),
        title: z.string(),
        truncated: z.boolean(),
        url: z.string(),
      },
      title: "Browser Snapshot",
    },
    async ({ boxes, confirm, depth, maxBytes, raw, sessionId }) => {
      const startedAt = Date.now();
      const argsRedacted = redactArgs({ boxes, confirm, depth, maxBytes, raw, sessionId });
      try {
        requireScope(runtime.context, SCOPES.browser);
        requireRawConfirm(raw, confirm, "browser_snapshot");
        const session = await getBrowserSession(runtime, sessionId);
        await assertActivePageInScope(session, "Browser snapshot page");
        const rawSnapshot = await session.page.locator("body").ariaSnapshot({ boxes, depth, mode: "ai", timeout: 10_000 });
        const snapshot = raw ? rawSnapshot : redactBrowserText(rawSnapshot);
        const capped = truncateUtf8(snapshot, outputBudget(runtime, maxBytes));
        await appendBrowserJournal({
          argsRedacted,
          outcome: "success",
          runtime,
          startedAt,
          tool: "browser_snapshot",
        });
        return jsonText({
          ariaSnapshot: capped.text,
          instructionSafety: INSTRUCTION_SAFETY_NOTE,
          raw,
          redacted: !raw,
          sessionId,
          sourceTrust: "untrusted_external_content",
          title: await safePageTitle(session.page, raw),
          truncated: capped.truncated,
          url: raw ? session.page.url() : redactUrl(session.page.url()),
        });
      } catch (error) {
        await appendBrowserJournal({
          argsRedacted,
          error,
          outcome: "error",
          runtime,
          startedAt,
          tool: "browser_snapshot",
        });
        return errorText(error);
      }
    },
  );
}

export function registerBrowserClickTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_click",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description:
        "Click an element by CSS selector or ARIA snapshot ref. Prefer ariaRef from browser_snapshot when available. On CDP existing-profile sessions, confirm=true is required.",
      inputSchema: {
        ariaRef: z.string().optional(),
        confirm: z.boolean().optional().default(false),
        expectedNavigationOrMutation: z.string().optional().describe("Expected page change, navigation, or no-op after this click."),
        purpose: z.string().min(1).describe("Short operational purpose for this click."),
        selector: z.string().optional(),
        sessionId: z.string().uuid(),
        targetDescription: z.string().min(1).describe("Human-readable target being clicked."),
        timeoutMs: timeoutSchema,
      },
      outputSchema: {
        auditQuality: z.enum(["browser-action"]),
        clicked: z.boolean(),
        closedOutOfScopePages: z.array(z.object({ pageIndex: z.number(), title: z.string(), url: z.string() })),
        expectedNavigationOrMutation: z.string().optional(),
        purpose: z.string(),
        sessionId: z.string(),
        targetDescription: z.string(),
        title: z.string(),
        url: z.string(),
      },
      title: "Browser Click",
    },
    async ({ ariaRef, confirm, expectedNavigationOrMutation, purpose, selector, sessionId, targetDescription, timeoutMs }) => {
      try {
        requireScope(runtime.context, SCOPES.browser);
        const session = await getBrowserSession(runtime, sessionId);
        requireCdpActionConfirm(session, confirm, "browser_click");
        const actionResult = await runJournaledOperation<{ closedOutOfScopePages: Array<{ pageIndex: number; title: string; url: string }> }>({
          argsRedacted: redactArgs({ ariaRef, confirm, expectedNavigationOrMutation, purpose, selector, sessionId, targetDescription, timeoutMs }),
          effect: async () => runScopedBrowserAction(session, "browser_click", async () => {
            await (await locatorFor(session.page, { ariaRef, selector })).click({ timeout: timeoutMs });
          }, { watchPopup: true }),
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.browser,
          requestId: runtime.context.requestId,
          tool: "browser_click",
        });
        return jsonText({
          auditQuality: "browser-action",
          clicked: true,
          closedOutOfScopePages: actionResult.closedOutOfScopePages,
          expectedNavigationOrMutation,
          purpose,
          sessionId,
          targetDescription,
          title: await safePageTitle(session.page),
          url: redactUrl(session.page.url()),
        });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerBrowserFillTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_fill",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description:
        "Fill an input-like element by CSS selector or ARIA snapshot ref. Prefer ariaRef from browser_snapshot when available. On CDP existing-profile sessions, confirm=true is required.",
      inputSchema: {
        ariaRef: z.string().optional(),
        confirm: z.boolean().optional().default(false),
        expectedNavigationOrMutation: z.string().optional(),
        purpose: z.string().min(1),
        selector: z.string().optional(),
        sessionId: z.string().uuid(),
        targetDescription: z.string().min(1),
        timeoutMs: timeoutSchema,
        value: z.string(),
      },
      outputSchema: {
        auditQuality: z.enum(["browser-action"]),
        closedOutOfScopePages: z.array(z.object({ pageIndex: z.number(), title: z.string(), url: z.string() })),
        expectedNavigationOrMutation: z.string().optional(),
        filled: z.boolean(),
        purpose: z.string(),
        sessionId: z.string(),
        targetDescription: z.string(),
        title: z.string(),
        url: z.string(),
      },
      title: "Browser Fill",
    },
    async ({ ariaRef, confirm, expectedNavigationOrMutation, purpose, selector, sessionId, targetDescription, timeoutMs, value }) => {
      try {
        requireScope(runtime.context, SCOPES.browser);
        const session = await getBrowserSession(runtime, sessionId);
        requireCdpActionConfirm(session, confirm, "browser_fill");
        const actionResult = await runJournaledOperation<{ closedOutOfScopePages: Array<{ pageIndex: number; title: string; url: string }> }>({
          argsRedacted: redactArgs({
            ariaRef,
            confirm,
            expectedNavigationOrMutation,
            purpose,
            selector,
            sessionId,
            targetDescription,
            timeoutMs,
            value: redactedInputLength(value),
          }),
          effect: async () => runScopedBrowserAction(session, "browser_fill", async () => {
            await (await locatorFor(session.page, { ariaRef, selector })).fill(value, { timeout: timeoutMs });
          }),
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.browser,
          requestId: runtime.context.requestId,
          tool: "browser_fill",
        });
        return jsonText({
          auditQuality: "browser-action",
          closedOutOfScopePages: actionResult.closedOutOfScopePages,
          expectedNavigationOrMutation,
          filled: true,
          purpose,
          sessionId,
          targetDescription,
          title: await safePageTitle(session.page),
          url: redactUrl(session.page.url()),
        });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerBrowserTypeTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_type",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description:
        "Type text into an element by CSS selector or ARIA snapshot ref. Prefer browser_fill for replacing input values. On CDP existing-profile sessions, confirm=true is required.",
      inputSchema: {
        ariaRef: z.string().optional(),
        confirm: z.boolean().optional().default(false),
        delayMs: z.number().int().min(0).max(1000).optional().default(0),
        expectedNavigationOrMutation: z.string().optional(),
        purpose: z.string().min(1),
        selector: z.string().optional(),
        sessionId: z.string().uuid(),
        targetDescription: z.string().min(1),
        text: z.string(),
        timeoutMs: timeoutSchema,
      },
      outputSchema: {
        auditQuality: z.enum(["browser-action"]),
        closedOutOfScopePages: z.array(z.object({ pageIndex: z.number(), title: z.string(), url: z.string() })),
        expectedNavigationOrMutation: z.string().optional(),
        purpose: z.string(),
        sessionId: z.string(),
        targetDescription: z.string(),
        title: z.string(),
        typed: z.boolean(),
        url: z.string(),
      },
      title: "Browser Type",
    },
    async ({ ariaRef, confirm, delayMs, expectedNavigationOrMutation, purpose, selector, sessionId, targetDescription, text, timeoutMs }) => {
      try {
        requireScope(runtime.context, SCOPES.browser);
        const session = await getBrowserSession(runtime, sessionId);
        requireCdpActionConfirm(session, confirm, "browser_type");
        const actionResult = await runJournaledOperation<{ closedOutOfScopePages: Array<{ pageIndex: number; title: string; url: string }> }>({
          argsRedacted: redactArgs({
            ariaRef,
            confirm,
            delayMs,
            expectedNavigationOrMutation,
            purpose,
            selector,
            sessionId,
            targetDescription,
            text: redactedInputLength(text),
            timeoutMs,
          }),
          effect: async () => runScopedBrowserAction(session, "browser_type", async () => {
            await (await locatorFor(session.page, { ariaRef, selector })).pressSequentially(text, { delay: delayMs, timeout: timeoutMs });
          }),
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.browser,
          requestId: runtime.context.requestId,
          tool: "browser_type",
        });
        return jsonText({
          auditQuality: "browser-action",
          closedOutOfScopePages: actionResult.closedOutOfScopePages,
          expectedNavigationOrMutation,
          purpose,
          sessionId,
          targetDescription,
          title: await safePageTitle(session.page),
          typed: true,
          url: redactUrl(session.page.url()),
        });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerBrowserPressKeyTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_press_key",
    {
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
      description:
        "Press a keyboard key in the active page. Prefer browser_click/fill/type for semantic interactions when possible. On CDP existing-profile sessions, confirm=true is required.",
      inputSchema: {
        confirm: z.boolean().optional().default(false),
        expectedNavigationOrMutation: z.string().optional(),
        key: z.string().min(1),
        purpose: z.string().min(1),
        sessionId: z.string().uuid(),
        targetDescription: z.string().min(1),
        timeoutMs: timeoutSchema,
      },
      outputSchema: {
        auditQuality: z.enum(["browser-action"]),
        closedOutOfScopePages: z.array(z.object({ pageIndex: z.number(), title: z.string(), url: z.string() })),
        expectedNavigationOrMutation: z.string().optional(),
        pressed: z.boolean(),
        purpose: z.string(),
        sessionId: z.string(),
        targetDescription: z.string(),
        title: z.string(),
        url: z.string(),
      },
      title: "Browser Press Key",
    },
    async ({ confirm, expectedNavigationOrMutation, key, purpose, sessionId, targetDescription, timeoutMs }) => {
      try {
        requireScope(runtime.context, SCOPES.browser);
        const session = await getBrowserSession(runtime, sessionId);
        requireCdpActionConfirm(session, confirm, "browser_press_key");
        const actionResult = await runJournaledOperation<{ closedOutOfScopePages: Array<{ pageIndex: number; title: string; url: string }> }>({
          argsRedacted: redactArgs({ confirm, expectedNavigationOrMutation, key, purpose, sessionId, targetDescription, timeoutMs }),
          effect: async () => runScopedBrowserAction(session, "browser_press_key", async () => {
            await session.page.keyboard.press(key, { delay: 0 });
          }),
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.browser,
          requestId: runtime.context.requestId,
          tool: "browser_press_key",
        });
        return jsonText({
          auditQuality: "browser-action",
          closedOutOfScopePages: actionResult.closedOutOfScopePages,
          expectedNavigationOrMutation,
          pressed: true,
          purpose,
          sessionId,
          targetDescription,
          title: await safePageTitle(session.page),
          url: redactUrl(session.page.url()),
        });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerBrowserWaitTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_wait",
    {
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false, readOnlyHint: true },
      description: "Wait for time, selector visibility, URL match, or load state in a browser session.",
      inputSchema: {
        loadState: z.enum(["domcontentloaded", "load", "networkidle"]).optional(),
        sessionId: z.string().uuid(),
        selector: z.string().optional(),
        timeoutMs: timeoutSchema,
        urlIncludes: z.string().optional(),
        waitMs: z.number().int().positive().max(60_000).optional(),
      },
      outputSchema: {
        closedOutOfScopePages: z.array(z.object({ pageIndex: z.number(), title: z.string(), url: z.string() })),
        sessionId: z.string(),
        title: z.string(),
        url: z.string(),
        waited: z.boolean(),
      },
      title: "Browser Wait",
    },
    async ({ loadState, selector, sessionId, timeoutMs, urlIncludes, waitMs }) => {
      const startedAt = Date.now();
      const argsRedacted = redactArgs({ loadState, selector, sessionId, timeoutMs, urlIncludes: urlIncludes ? redactBrowserText(urlIncludes) : undefined, waitMs });
      try {
        requireScope(runtime.context, SCOPES.browser);
        const session = await getBrowserSession(runtime, sessionId);
        await assertActivePageInScope(session, "browser_wait page");
        if (waitMs) await session.page.waitForTimeout(waitMs);
        if (loadState) await session.page.waitForLoadState(loadState, { timeout: timeoutMs });
        if (selector) await session.page.locator(selector).waitFor({ timeout: timeoutMs });
        if (urlIncludes) await session.page.waitForURL((url) => url.href.includes(urlIncludes), { timeout: timeoutMs });
        const closedOutOfScopePages = await closeOutOfScopeInactivePages(session);
        await assertActivePageInScope(session, "browser_wait after wait");
        await appendBrowserJournal({
          argsRedacted,
          outcome: "success",
          runtime,
          startedAt,
          tool: "browser_wait",
        });
        return jsonText({
          closedOutOfScopePages,
          sessionId,
          title: await safePageTitle(session.page),
          url: redactUrl(session.page.url()),
          waited: true,
        });
      } catch (error) {
        await appendBrowserJournal({
          argsRedacted,
          error,
          outcome: "error",
          runtime,
          startedAt,
          tool: "browser_wait",
        });
        return errorText(error);
      }
    },
  );
}

export function registerBrowserScreenshotTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_screenshot",
    {
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false, readOnlyHint: true },
      description:
        "Capture a PNG screenshot of the current browser page. Prefer browser_snapshot for DOM/ARIA understanding; use screenshot when visual layout, pixels, or rendering must be inspected.",
      inputSchema: { fullPage: z.boolean().optional().default(false), includeImageBase64: z.boolean().optional().default(false), sessionId: z.string().uuid() },
      outputSchema: {
        auditQuality: z.enum(["visual"]),
        hash: z.string(),
        imageBase64: z.string().optional(),
        instructionSafety: z.string(),
        path: z.string(),
        screenshotId: z.string(),
        sessionId: z.string(),
        size: z.number(),
        sourceTrust: z.enum(["untrusted_external_content"]),
        title: z.string(),
        url: z.string(),
      },
      title: "Browser Screenshot",
    },
    async ({ fullPage, includeImageBase64, sessionId }) => {
      try {
        requireScope(runtime.context, SCOPES.browser);
        const session = await getBrowserSession(runtime, sessionId);
        await assertActivePageInScope(session, "browser_screenshot page");
        const screenshotId = crypto.randomUUID();
        const directory = path.join(browserDataDir(runtime), "screenshots");
        const filePath = path.join(directory, `${screenshotId}.png`);
        let cleanupEffects: FileEffect[] = [];
        const metadata = await runJournaledOperation<{ hash: string; size: number }>({
          afterSnapshot: () => browserScreenshotEffects(filePath, directory, cleanupEffects),
          argsRedacted: redactArgs({ fullPage, includeImageBase64, sessionId }),
          beforeSnapshot: () => plannedBrowserScreenshotEffects(filePath, directory),
          effect: async () => {
            await fs.mkdir(directory, { recursive: true });
            await session.page.screenshot({ fullPage, path: filePath, type: "png" });
            const created = await screenshotMetadata(filePath);
            if (created.size > runtime.config.maxBrowserScreenshotBytes) {
              await fs.unlink(filePath).catch(() => undefined);
              throw new Error(`Browser screenshot too large: ${created.size} bytes > ${runtime.config.maxBrowserScreenshotBytes}`);
            }
            if (includeImageBase64 && browserScreenshotBase64Bytes(created.size) > runtime.config.maxOutputBytes) {
              throw new Error(`Browser screenshot too large for inline output: ${browserScreenshotBase64Bytes(created.size)} bytes`);
            }
            cleanupEffects = await cleanupBrowserScreenshots(runtime, directory, filePath);
            return created;
          },
          identity: runtime.context.identity,
          journal: runtime.journal,
          requiredScope: SCOPES.browser,
          requestId: runtime.context.requestId,
          tool: "browser_screenshot",
        });
        const result: Record<string, unknown> = {
          auditQuality: "visual",
          hash: metadata.hash,
          instructionSafety: INSTRUCTION_SAFETY_NOTE,
          path: filePath,
          screenshotId,
          sessionId,
          size: metadata.size,
          sourceTrust: "untrusted_external_content",
          title: await safePageTitle(session.page),
          url: redactUrl(session.page.url()),
        };
        if (includeImageBase64) {
          result.imageBase64 = (await fs.readFile(filePath)).toString("base64");
        }
        return jsonText(result);
      } catch (error) {
        return errorText(error);
      }
    },
  );
}

export function registerBrowserConsoleTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_console",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
      description: "Return recent console messages captured for a browser session.",
      inputSchema: {
        confirm: z.boolean().optional().default(false),
        limit: z.number().int().positive().max(500).optional().default(100),
        maxBytes: z.number().int().positive().max(1_000_000).optional(),
        raw: z.boolean().optional().default(false),
        sessionId: z.string().uuid(),
      },
      outputSchema: {
        entries: z.array(z.object({ location: z.string().optional(), text: z.string(), textTruncated: z.boolean().optional(), timestamp: z.string(), type: z.string() })),
        instructionSafety: z.string(),
        raw: z.boolean(),
        redacted: z.boolean(),
        sessionId: z.string(),
        sourceTrust: z.enum(["untrusted_external_content"]),
        totalBytes: z.number(),
        truncated: z.boolean(),
      },
      title: "Browser Console",
    },
    async ({ confirm, limit, maxBytes, raw, sessionId }) => {
      const startedAt = Date.now();
      const argsRedacted = redactArgs({ confirm, limit, maxBytes, raw, sessionId });
      try {
        requireScope(runtime.context, SCOPES.browser);
        requireRawConfirm(raw, confirm, "browser_console");
        const session = await getBrowserSession(runtime, sessionId);
        await assertActivePageInScope(session, "browser_console page");
        const entries = session.console
          .slice(-limit)
          .map((entry) => formatConsoleEntry(entry, raw, Math.min(8192, outputBudget(runtime, maxBytes))));
        const fitted = fitEntriesToBudget(entries, outputBudget(runtime, maxBytes));
        await appendBrowserJournal({
          argsRedacted,
          outcome: "success",
          runtime,
          startedAt,
          tool: "browser_console",
        });
        return jsonText({
          entries: fitted.entries,
          instructionSafety: INSTRUCTION_SAFETY_NOTE,
          raw,
          redacted: !raw,
          sessionId,
          sourceTrust: "untrusted_external_content",
          totalBytes: fitted.totalBytes,
          truncated: fitted.truncated,
        });
      } catch (error) {
        await appendBrowserJournal({
          argsRedacted,
          error,
          outcome: "error",
          runtime,
          startedAt,
          tool: "browser_console",
        });
        return errorText(error);
      }
    },
  );
}

export function registerBrowserNetworkTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "browser_network",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
      description: "Return recent network response/failure events captured for a browser session.",
      inputSchema: {
        confirm: z.boolean().optional().default(false),
        limit: z.number().int().positive().max(500).optional().default(100),
        maxBytes: z.number().int().positive().max(1_000_000).optional(),
        raw: z.boolean().optional().default(false),
        sessionId: z.string().uuid(),
      },
      outputSchema: {
        entries: z.array(
          z.object({
            error: z.string().optional(),
            errorTruncated: z.boolean().optional(),
            method: z.string(),
            status: z.number().optional(),
            timestamp: z.string(),
            type: z.enum(["response", "requestfailed"]),
            url: z.string(),
            urlTruncated: z.boolean().optional(),
          }),
        ),
        instructionSafety: z.string(),
        raw: z.boolean(),
        redacted: z.boolean(),
        sessionId: z.string(),
        sourceTrust: z.enum(["untrusted_external_content"]),
        totalBytes: z.number(),
        truncated: z.boolean(),
      },
      title: "Browser Network",
    },
    async ({ confirm, limit, maxBytes, raw, sessionId }) => {
      const startedAt = Date.now();
      const argsRedacted = redactArgs({ confirm, limit, maxBytes, raw, sessionId });
      try {
        requireScope(runtime.context, SCOPES.browser);
        requireRawConfirm(raw, confirm, "browser_network");
        const session = await getBrowserSession(runtime, sessionId);
        await assertActivePageInScope(session, "browser_network page");
        const entries = session.network
          .slice(-limit)
          .map((entry) => formatNetworkEntry(entry, raw, Math.min(4096, outputBudget(runtime, maxBytes))));
        const fitted = fitEntriesToBudget(entries, outputBudget(runtime, maxBytes));
        await appendBrowserJournal({
          argsRedacted,
          outcome: "success",
          runtime,
          startedAt,
          tool: "browser_network",
        });
        return jsonText({
          entries: fitted.entries,
          instructionSafety: INSTRUCTION_SAFETY_NOTE,
          raw,
          redacted: !raw,
          sessionId,
          sourceTrust: "untrusted_external_content",
          totalBytes: fitted.totalBytes,
          truncated: fitted.truncated,
        });
      } catch (error) {
        await appendBrowserJournal({
          argsRedacted,
          error,
          outcome: "error",
          runtime,
          startedAt,
          tool: "browser_network",
        });
        return errorText(error);
      }
    },
  );
}

export function registerBrowserTools(server: McpServer, runtime: McpRuntime): void {
  registerBrowserCdpConnectTool(server, runtime);
  registerBrowserSessionCreateTool(server, runtime);
  registerBrowserSessionListTool(server, runtime);
  registerBrowserSessionCloseTool(server, runtime);
  registerBrowserPageListTool(server, runtime);
  registerBrowserPageSelectTool(server, runtime);
  registerBrowserNavigateTool(server, runtime);
  registerBrowserSnapshotTool(server, runtime);
  registerBrowserClickTool(server, runtime);
  registerBrowserFillTool(server, runtime);
  registerBrowserTypeTool(server, runtime);
  registerBrowserPressKeyTool(server, runtime);
  registerBrowserWaitTool(server, runtime);
  registerBrowserScreenshotTool(server, runtime);
  registerBrowserConsoleTool(server, runtime);
  registerBrowserNetworkTool(server, runtime);
}
