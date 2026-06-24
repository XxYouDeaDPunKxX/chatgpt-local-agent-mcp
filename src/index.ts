import crypto from "node:crypto";
import path from "node:path";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { NextFunction, Request, Response } from "express";
import { WorkspaceProfile } from "./config.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { AuthStore } from "./auth/store.js";
import { loadConfig } from "./config.js";
import { registerDashboardRoutes } from "./dashboard/index.js";
import { Journal } from "./journal.js";
import { createMcpServer } from "./mcp.js";
import { isPolicyModeAllowed } from "./policy.js";
import { createDevExecutionContext, ExecutionContext } from "./runtime.js";
import { hasScope } from "./scopes.js";
import { definitionForTool } from "./tools/registry.js";

const config = loadConfig();
const app = express();
const authStore = new AuthStore(config);
const journal = new Journal(config.journalPath);
const SMALL_BODY_LIMIT = "1mb";

app.use(hostHeaderValidation(config.allowedHosts));
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} -> ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});
await journal.ensureWritable();
const recoveredOperations = await journal.markPendingOperationsUnknown();
if (recoveredOperations.length) {
  console.warn(`Journal recovery marked ${recoveredOperations.length} incomplete operation(s) as unknown.`);
}

type BodyParserError = Error & {
  status?: number;
  type?: string;
};

function bodyParserErrorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  const parserError = error as BodyParserError;
  const isTooLarge = parserError.type === "entity.too.large" || parserError.status === 413;
  const isParseError = parserError.type === "entity.parse.failed" || error instanceof SyntaxError;
  if (!isTooLarge && !isParseError) {
    next(error);
    return;
  }

  const isMcp = req.path === "/mcp";
  if (isTooLarge) {
    res.status(413).json(
      isMcp
        ? {
            error: { code: -32000, message: "Payload too large" },
            id: null,
            jsonrpc: "2.0",
          }
        : {
            error: "invalid_request",
            error_description: "Request body too large",
          },
    );
    return;
  }

  res.status(400).json(
    isMcp
      ? {
          error: { code: -32700, message: "Parse error" },
          id: null,
          jsonrpc: "2.0",
        }
      : {
          error: "invalid_request",
          error_description: "Malformed request body",
        },
  );
}

app.use(["/token", "/dashboard"], express.json({ limit: SMALL_BODY_LIMIT }));
app.use(["/token", "/dashboard"], express.urlencoded({ extended: false, limit: SMALL_BODY_LIMIT }));
app.use(bodyParserErrorHandler);

registerAuthRoutes(app, config, authStore);
registerDashboardRoutes(app, { config, journal, recoveredOperations });

function unauthorized(res: Response, error = "invalid_token"): void {
  res
    .status(401)
    .set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${config.protectedResourceMetadataUrl}", error="${error}"`,
    )
    .json({
      error,
      resource_metadata: config.protectedResourceMetadataUrl,
    });
}

function authenticateMcpRequest(req: Request, res: Response): ExecutionContext | undefined {
  if (!config.authRequired) {
    return createDevExecutionContext(config);
  }

  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    unauthorized(res, "missing_token");
    return undefined;
  }

  const record = authStore.getAccessToken(auth.slice("Bearer ".length));
  if (!record) {
    unauthorized(res, "invalid_token");
    return undefined;
  }

  return {
    identity: {
      provider: "github",
      subject: record.subject,
      login: record.login,
    },
    requestId: crypto.randomUUID(),
    scopes: record.scopes,
  };
}

function authenticateMcpRequestMiddleware(req: Request, res: Response, next: NextFunction): void {
  const context = authenticateMcpRequest(req, res);
  if (!context) {
    return;
  }
  res.locals.mcpContext = context;
  next();
}

function mcpContextFromResponse(res: Response): ExecutionContext {
  const context = res.locals.mcpContext;
  if (!context) {
    throw new Error("MCP context missing after authentication");
  }
  return context as ExecutionContext;
}

type ToolCall = {
  arguments: Record<string, unknown>;
  name: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toolCalls(body: unknown): ToolCall[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages
    .filter((message): message is { method?: unknown; params?: { arguments?: unknown; name?: unknown } } => {
      return !!message && typeof message === "object";
    })
    .filter((message) => message.method === "tools/call")
    .map((message) => ({
      arguments: asRecord(message.params?.arguments),
      name: message.params?.name,
    }))
    .filter((call): call is ToolCall => typeof call.name === "string");
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value ? value : undefined;
}

function resolveArgumentPath(cwd: string | undefined, inputPath = "."): string {
  return path.resolve(cwd || config.defaultCwd, inputPath);
}

function candidatePathsForTool(toolName: string, args: Record<string, unknown>): string[] {
  const cwd = stringArg(args, "cwd");
  switch (toolName) {
    case "workspace_info":
      return [];
    case "shell":
    case "apply_patch":
    case "git_status":
    case "git_diff":
    case "git_commit":
    case "start_process":
      return [resolveArgumentPath(cwd)];
    case "tail_log": {
      const inputPath = stringArg(args, "path");
      return inputPath ? [resolveArgumentPath(cwd), resolveArgumentPath(cwd, inputPath)] : [];
    }
    case "process_list":
    case "process_kill":
    case "port_list":
    case "wait_for_port":
    case "stop_process":
      return [];
    case "list_dir":
    case "stat":
    case "tree":
    case "read_file":
    case "read_file_range":
    case "hash":
    case "search":
    case "write_file":
    case "mkdir":
    case "delete": {
      const inputPath = stringArg(args, "path") || ".";
      return [resolveArgumentPath(cwd), resolveArgumentPath(cwd, inputPath)];
    }
    case "stat_many":
    case "read_many": {
      const paths = Array.isArray(args.paths) ? args.paths.filter((item): item is string => typeof item === "string") : ["."];
      return [resolveArgumentPath(cwd), ...paths.map((item) => resolveArgumentPath(cwd, item))];
    }
    case "copy":
    case "move": {
      const from = stringArg(args, "from") || ".";
      const to = stringArg(args, "to") || ".";
      return [resolveArgumentPath(cwd), resolveArgumentPath(cwd, from), resolveArgumentPath(cwd, to)];
    }
    default:
      return [];
  }
}

function normalizePathForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function containsPath(rootPath: string, candidatePath: string): boolean {
  const root = normalizePathForCompare(rootPath);
  const candidate = normalizePathForCompare(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function profileForPath(candidatePath: string): WorkspaceProfile | undefined {
  return [...config.workspaceProfiles]
    .filter((profile) => containsPath(profile.rootPath, candidatePath))
    .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
}

function rejectToolPreflight(req: Request, res: Response, context: ExecutionContext): boolean {
  for (const call of toolCalls(req.body)) {
    const definition = definitionForTool(call.name);
    if (!definition) {
      continue;
    }

    if (!isPolicyModeAllowed(definition.policyMode, config.maxPolicyMode)) {
      res.status(403).json({
        error: "policy_denied",
        max_policy_mode: config.maxPolicyMode,
        policy_mode: definition.policyMode,
        tool: call.name,
      });
      return true;
    }

    if (config.enforceWorkspaceProfiles) {
      for (const candidatePath of candidatePathsForTool(call.name, call.arguments)) {
        const profile = profileForPath(candidatePath);
        if (!profile) {
          res.status(403).json({
            error: "workspace_denied",
            path: candidatePath,
            tool: call.name,
          });
          return true;
        }
        if (!profile.allowedPolicyModes.includes(definition.policyMode)) {
          res.status(403).json({
            allowed_policy_modes: profile.allowedPolicyModes,
            error: "workspace_policy_denied",
            path: candidatePath,
            policy_mode: definition.policyMode,
            profile: profile.name,
            tool: call.name,
          });
          return true;
        }
      }
    }

    const requiredScope = definition.requiredScope;
    if (requiredScope && !hasScope(context.scopes, requiredScope)) {
      res.status(403).json({
        error: "insufficient_scope",
        required_scope: requiredScope,
        tool: call.name,
      });
      return true;
    }
  }

  return false;
}

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

app.get("/healthz", (_req, res) => {
  res.json({
    authRequired: config.authRequired,
    name: "chatgpt-local-agent-mcp",
    ok: true,
    transport: "streamable-http",
    version: "0.1.0",
  });
});

app.get("/debug/healthz", (_req, res) => {
  if (!config.exposeRuntimeDebug) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({
    authRequired: config.authRequired,
    defaultCwd: config.defaultCwd,
    journalPath: config.journalPath,
    name: "chatgpt-local-agent-mcp",
    ok: true,
    pid: process.pid,
    publicBaseUrl: config.publicBaseUrl,
    resourceUri: config.resourceUri,
    transport: "streamable-http",
    version: "0.1.0",
  });
});

app.post("/mcp", authenticateMcpRequestMiddleware, express.json({ limit: config.maxBodyBytes }), bodyParserErrorHandler, asyncRoute(async (req, res) => {
  const context = mcpContextFromResponse(res);
  if (rejectToolPreflight(req, res, context)) {
    return;
  }

  const server = createMcpServer({
    config,
    context,
    journal,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    void transport.close();
    void server.close();
  };
  res.on("close", cleanup);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
        jsonrpc: "2.0",
      });
    }
  } finally {
    if (res.writableEnded || res.closed) {
      cleanup();
    }
  }
}));

function methodNotAllowed(res: Response, message: string): void {
  res.status(405).json({
    error: {
      code: -32000,
      message,
    },
    id: null,
    jsonrpc: "2.0",
  });
}

function rejectUnauthenticatedUnsupportedMcpMethod(req: Request, res: Response): boolean {
  if (config.authRequired && !req.headers.authorization?.startsWith("Bearer ")) {
    unauthorized(res, "missing_token");
    return true;
  }

  return false;
}

app.get("/mcp", (req, res) => {
  if (rejectUnauthenticatedUnsupportedMcpMethod(req, res)) {
    return;
  }

  methodNotAllowed(res, "Method not allowed. Use POST /mcp for stateless Streamable HTTP.");
});

app.delete("/mcp", (req, res) => {
  if (rejectUnauthenticatedUnsupportedMcpMethod(req, res)) {
    return;
  }

  methodNotAllowed(res, "Method not allowed in stateless mode.");
});

app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  console.error("Unhandled request error:", error);
  if (req.path === "/mcp") {
    res.status(500).json({
      error: {
        code: -32603,
        message: "Internal server error",
      },
      id: null,
      jsonrpc: "2.0",
    });
    return;
  }

  if (req.path === "/authorize" || req.path === "/callback") {
    res.status(500).type("html").send("<!doctype html><title>Request failed</title><p>Request failed.</p>");
    return;
  }

  res.status(500).json({
    error: "server_error",
    error_description: "Request failed",
  });
});

app.listen(config.port, config.host, (error?: Error) => {
  if (error) {
    console.error("Failed to start chatgpt-local-agent-mcp:", error);
    process.exit(1);
  }

  console.log(`chatgpt-local-agent-mcp listening at http://${config.host}:${config.port}`);
  console.log(`Default cwd: ${config.defaultCwd}`);
  console.log(`Auth required: ${config.authRequired}`);
  if (!config.authRequired) {
    console.warn("WARNING: AUTH_REQUIRED=false. Local development mode only. Do not expose this server.");
  }
});
