import { randomUUID } from "node:crypto";
import { AppConfig } from "./config.js";
import { ALL_SCOPES, Scope, hasScope } from "./scopes.js";

export type ExecutionIdentity = {
  provider: "github" | "local-dev";
  subject: string;
  login?: string;
};

export type ExecutionContext = {
  identity: ExecutionIdentity;
  requestId: string;
  scopes: string[];
};

export function createDevExecutionContext(config: AppConfig): ExecutionContext {
  return {
    identity: {
      provider: "local-dev",
      subject: config.devIdentityLogin,
      login: config.devIdentityLogin,
    },
    requestId: randomUUID(),
    scopes: [...ALL_SCOPES],
  };
}

export function requireScope(context: ExecutionContext, requiredScope: Scope): void {
  if (!hasScope(context.scopes, requiredScope)) {
    throw new Error(`Missing required scope: ${requiredScope}`);
  }
}
