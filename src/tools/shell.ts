import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BoundedCommandResult, runBoundedCommand, shellCommandArgs } from "../command.js";
import { assertCommandPolicyAllowed } from "../command-policy.js";
import { errorText, jsonText } from "../format.js";
import { assertPathAllowed, assertPolicyModeAllowed } from "../guards.js";
import { redactArgs, redactShellCommand, runJournaledOperation } from "../journal.js";
import { McpRuntime } from "../mcp.js";
import { resolveCwd, warningsForCommand } from "../paths.js";
import { requireScope } from "../runtime.js";
import { SCOPES } from "../scopes.js";

const nullableNumber = z.union([z.number(), z.null()]);
const nullableString = z.union([z.string(), z.null()]);

export function registerShellTool(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "shell",
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Escape hatch for local command execution when no dedicated MCP tool covers the action. Use shell for tests, builds, one-shot CLI commands, and true fallback cases. Do not use it for file writes, git operations, long-running processes, log tailing, search, delete/move/copy/mkdir when dedicated tools cover the task. On Windows this uses PowerShell. Shell keeps full access but has coarse audit effects.",
      inputSchema: {
        command: z.string().min(1).describe("Command to execute."),
        cwd: z.string().describe("Required working directory."),
        dedicatedToolBypassReason: z
          .string()
          .min(1)
          .describe("Why a dedicated MCP tool is not sufficient for this command."),
        expectedTouchedPaths: z
          .array(z.string())
          .optional()
          .default([])
          .describe("Expected file or directory paths this shell command may touch, relative to cwd when not absolute."),
        purpose: z.string().min(1).describe("Short operational purpose for this shell command."),
        timeoutMs: z.number().int().positive().max(600_000).optional(),
      },
      outputSchema: {
        auditQuality: z.enum(["coarse"]),
        code: nullableNumber,
        command: z.string(),
        cwd: z.string(),
        dedicatedToolBypassReason: z.string(),
        durationMs: z.number(),
        executable: z.string(),
        expectedTouchedPaths: z.array(z.string()),
        outputLimitExceeded: z.boolean(),
        purpose: z.string(),
        signal: nullableString,
        stderr: z.string(),
        stderrTruncated: z.boolean(),
        stdout: z.string(),
        stdoutTruncated: z.boolean(),
        timedOut: z.boolean(),
        effectivePathHints: z
          .array(
            z.object({
              absolutePath: z.string(),
              token: z.string(),
            }),
          )
          .optional(),
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
      title: "Run Shell Command",
    },
    async ({ command, cwd, dedicatedToolBypassReason, expectedTouchedPaths, purpose, timeoutMs }) => {
      const startedAt = Date.now();
      let operationStarted = false;
      try {
        requireScope(runtime.context, SCOPES.shell);
        assertPolicyModeAllowed(runtime.config, "operate");
        const { args, executable } = shellCommandArgs(command);
        const workingDirectory = await resolveCwd(cwd);
        assertPathAllowed(runtime.config, workingDirectory, "operate", { checkSecret: true });
        const timeout = timeoutMs || runtime.config.shellTimeoutMs;
        const { effectivePathHints, warnings } = warningsForCommand(workingDirectory, command, expectedTouchedPaths);
        assertCommandPolicyAllowed({
          command,
          config: runtime.config,
          cwd: workingDirectory,
          expectedTouchedPaths,
          policy: runtime.config.shellPolicy,
          policyMode: "operate",
          tool: "shell",
        });
        const argsRedacted = redactArgs({
          command: redactShellCommand(command),
          cwd,
          dedicatedToolBypassReason,
          executable,
          expectedTouchedPaths,
          maxOutputBytes: runtime.config.maxOutputBytes,
          purpose,
          timeoutMs: timeout,
        });

        operationStarted = true;
        const result = await runJournaledOperation<BoundedCommandResult>({
          argsRedacted,
          cwd: workingDirectory,
          effect: async () =>
            runBoundedCommand({
              args,
              cwd: workingDirectory,
              executable,
              maxOutputBytes: runtime.config.maxOutputBytes,
              timeoutMs: timeout,
            }),
          identity: runtime.context.identity,
          journal: runtime.journal,
          outcomeFromResult: (result) => ({
            exitCode: result.code,
            outcome: result.code === 0 && !result.timedOut && !result.outputLimitExceeded ? "success" : "error",
            outputLimitExceeded: result.outputLimitExceeded,
            signal: result.signal,
            stderrTruncated: result.stderrTruncated,
            stdoutTruncated: result.stdoutTruncated,
            timedOut: result.timedOut,
          }),
          outcomeFromError: () => ({
            exitCode: null,
            outputLimitExceeded: false,
            signal: null,
            stderrTruncated: false,
            stdoutTruncated: false,
            timedOut: false,
          }),
          requiredScope: SCOPES.shell,
          requestId: runtime.context.requestId,
          tool: "shell",
        });

        const durationMs = Date.now() - startedAt;

        const response = jsonText({
          auditQuality: "coarse",
          code: result.code,
          command: redactShellCommand(command),
          cwd: workingDirectory,
          dedicatedToolBypassReason,
          durationMs,
          executable,
          expectedTouchedPaths,
          signal: result.signal,
          stderr: result.stderr,
          stderrTruncated: result.stderrTruncated,
          stdout: result.stdout,
          stdoutTruncated: result.stdoutTruncated,
          timedOut: result.timedOut,
          outputLimitExceeded: result.outputLimitExceeded,
          purpose,
          effectivePathHints,
          warnings,
        });
        if (result.code !== 0 || result.timedOut || result.outputLimitExceeded) {
          return {
            ...response,
            isError: true,
          };
        }
        return response;
      } catch (error) {
        if (!operationStarted) {
          await runtime.journal.append({
            argsRedacted: redactArgs({
              command: redactShellCommand(command),
              cwd,
              dedicatedToolBypassReason,
              expectedTouchedPaths,
              purpose,
              timeoutMs,
            }),
            cwd,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
            id: runtime.context.requestId,
            identity: runtime.context.identity,
            outcome: "error",
            requiredScope: SCOPES.shell,
            timestamp: new Date().toISOString(),
            tool: "shell",
          });
        }
        return errorText(error);
      }
    },
  );
}
