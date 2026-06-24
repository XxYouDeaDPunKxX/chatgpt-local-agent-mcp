export const SCOPES = {
  delete: "mcp:delete",
  browser: "mcp:browser",
  desktop: "mcp:desktop",
  git: "mcp:git",
  patch: "mcp:patch",
  process: "mcp:process",
  read: "mcp:read",
  screen: "mcp:screen",
  shell: "mcp:shell",
  write: "mcp:write",
} as const;

export const ALL_SCOPES = Object.values(SCOPES);

export type Scope = (typeof ALL_SCOPES)[number];

export function hasScope(granted: string[], required: Scope): boolean {
  return granted.includes(required);
}
