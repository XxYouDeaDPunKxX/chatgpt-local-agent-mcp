import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppConfig } from "./config.js";
import { Journal } from "./journal.js";
import { ExecutionContext } from "./runtime.js";
import { registerAllTools } from "./tools/registry.js";

// Keep MCP argument validation bounded before tool schemas are evaluated.
export const MAX_TOOL_INPUT_ELEMENTS = 10_000;

export type McpRuntime = {
  config: AppConfig;
  context: ExecutionContext;
  journal: Journal;
};

export function createMcpServer(runtime: McpRuntime): McpServer {
  const server = new McpServer({
    name: "chatgpt-local-agent-mcp",
    version: "0.1.0",
  }, { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS });

  registerAllTools(server, runtime);

  return server;
}
