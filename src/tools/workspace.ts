import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonText } from "../format.js";
import { redactArgs } from "../journal.js";
import { McpRuntime } from "../mcp.js";
import { requireScope } from "../runtime.js";
import { SCOPES } from "../scopes.js";

export function registerWorkspaceInfoTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "workspace_info",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "Return runtime information about the local MCP runner and its default workspace.",
      inputSchema: {},
      outputSchema: {
        authRequired: z.boolean(),
        defaultCwd: z.string(),
        enforceWorkspaceProfiles: z.boolean(),
        host: z.string().optional(),
        maxPolicyMode: z.enum(["observe", "diagnose", "edit", "operate", "destructive"]),
        node: z.string().optional(),
        pid: z.number().optional(),
        platform: z.string(),
        port: z.number().optional(),
        processPolicy: z.enum(["disabled", "workspace_guarded", "full"]),
        resourceUri: z.string().optional(),
        shellPolicy: z.enum(["disabled", "workspace_guarded", "full"]),
        shellTimeoutMs: z.number(),
        user: z.string().optional(),
        workspaceProfiles: z.array(
          z.object({
            allowedPolicyModes: z.array(z.enum(["observe", "diagnose", "edit", "operate", "destructive"])),
            backupPolicy: z.enum(["none", "manual", "snapshot"]),
            label: z.string(),
            name: z.string(),
            rootPath: z.string(),
            secretDenyGlobs: z.array(z.string()),
          }),
        ),
      },
      title: "Workspace Info",
    },
    async () => {
      const startedAt = Date.now();
      try {
        requireScope(runtime.context, SCOPES.read);
        const result = {
          authRequired: runtime.config.authRequired,
          defaultCwd: runtime.config.defaultCwd,
          enforceWorkspaceProfiles: runtime.config.enforceWorkspaceProfiles,
          maxPolicyMode: runtime.config.maxPolicyMode,
          platform: process.platform,
          processPolicy: runtime.config.processPolicy,
          shellPolicy: runtime.config.shellPolicy,
          shellTimeoutMs: runtime.config.shellTimeoutMs,
          workspaceProfiles: runtime.config.workspaceProfiles,
          ...(runtime.config.exposeRuntimeDebug
            ? {
                host: runtime.config.host,
                node: process.version,
                pid: process.pid,
                port: runtime.config.port,
                resourceUri: runtime.config.resourceUri,
                user: os.userInfo().username,
              }
            : {}),
        };
        await runtime.journal.append({
          argsRedacted: redactArgs({}),
          durationMs: Date.now() - startedAt,
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "success",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "workspace_info",
        });
        return jsonText(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await runtime.journal.append({
          argsRedacted: redactArgs({}),
          durationMs: Date.now() - startedAt,
          error: message,
          id: runtime.context.requestId,
          identity: runtime.context.identity,
          outcome: "error",
          requiredScope: SCOPES.read,
          timestamp: new Date().toISOString(),
          tool: "workspace_info",
        });
        throw error;
      }
    },
  );
}
