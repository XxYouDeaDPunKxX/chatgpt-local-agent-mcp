import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppConfig } from "./config.js";
import { Journal } from "./journal.js";
import { ExecutionContext } from "./runtime.js";
import { registerAllTools } from "./tools/registry.js";

export type McpRuntime = {
  config: AppConfig;
  context: ExecutionContext;
  journal: Journal;
};

export function createMcpServer(runtime: McpRuntime): McpServer {
  const server = new McpServer({
    name: "gpt-file-system-mcp",
    version: "0.1.0",
  });

  registerAllTools(server, runtime);

  return server;
}
