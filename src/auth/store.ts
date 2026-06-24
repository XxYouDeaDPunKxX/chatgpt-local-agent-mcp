import crypto from "node:crypto";
import { AppConfig } from "../config.js";
import { ALL_SCOPES, Scope } from "../scopes.js";

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

export class InvalidScopeError extends Error {
  constructor(public readonly scopes: string[]) {
    super(`Invalid scope: ${scopes.join(" ")}`);
  }
}

export class AuthStoreCapacityError extends Error {
  constructor(public readonly label: string) {
    super(`Auth store capacity reached for ${label}`);
  }
}

export type PendingAuthorizeRecord = {
  clientId: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256";
  createdAt: number;
  redirectUri: string;
  resource: string;
  scope: string[];
  state: string;
};

export type AuthCodeRecord = PendingAuthorizeRecord & {
  codeHash: string;
  expiresAt: number;
  login: string;
  subject: string;
  usedAt?: number;
};

export type AccessTokenRecord = {
  audience: string;
  expiresAt: string;
  issuedAt: string;
  login: string;
  scopes: string[];
  subject: string;
  tokenHash: string;
};

export class AuthStore {
  private readonly authCodes = new Map<string, AuthCodeRecord>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly pendingGithubStates = new Map<string, PendingAuthorizeRecord>();
  private readonly tokens = new Map<string, AccessTokenRecord>();

  constructor(private readonly config: AppConfig) {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), config.authStoreCleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  createPendingAuthorize(record: Omit<PendingAuthorizeRecord, "createdAt">): string {
    this.cleanupExpired();
    this.enforceLimit(this.pendingGithubStates, this.config.authStoreMaxPending, "pending authorizations");
    const stateId = randomToken();
    this.pendingGithubStates.set(stateId, {
      ...record,
      createdAt: Date.now(),
    });
    return stateId;
  }

  consumePendingAuthorize(stateId: string): PendingAuthorizeRecord | undefined {
    this.cleanupExpired();
    const record = this.pendingGithubStates.get(stateId);
    this.pendingGithubStates.delete(stateId);
    if (record && record.createdAt + 10 * 60 * 1000 < Date.now()) {
      return undefined;
    }
    return record;
  }

  createAuthCode(record: Omit<AuthCodeRecord, "codeHash" | "expiresAt">): string {
    this.cleanupExpired();
    this.enforceLimit(this.authCodes, this.config.authStoreMaxAuthCodes, "authorization codes");
    const code = randomToken();
    const codeHash = hashToken(code);
    this.authCodes.set(codeHash, {
      ...record,
      codeHash,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    return code;
  }

  getAuthCode(code: string): AuthCodeRecord | undefined {
    this.cleanupExpired();
    const codeHash = hashToken(code);
    const record = this.authCodes.get(codeHash);
    if (!record || record.usedAt || record.expiresAt < Date.now()) {
      return undefined;
    }
    return record;
  }

  markAuthCodeUsed(code: string): void {
    const codeHash = hashToken(code);
    const record = this.authCodes.get(codeHash);
    if (record) {
      record.usedAt = Date.now();
    }
  }

  issueAccessToken(record: Omit<AccessTokenRecord, "expiresAt" | "issuedAt" | "tokenHash">): {
    expiresIn: number;
    token: string;
  } {
    this.cleanupExpired();
    this.enforceLimit(this.tokens, this.config.authStoreMaxTokens, "access tokens");
    const token = randomToken();
    const tokenHash = hashToken(token);
    const issuedAt = new Date();
    const expiresIn = ACCESS_TOKEN_TTL_SECONDS;
    const expiresAt = new Date(issuedAt.getTime() + expiresIn * 1000);
    this.tokens.set(tokenHash, {
      ...record,
      expiresAt: expiresAt.toISOString(),
      issuedAt: issuedAt.toISOString(),
      tokenHash,
    });
    return { expiresIn, token };
  }

  getAccessToken(token: string): AccessTokenRecord | undefined {
    this.cleanupExpired();
    const record = this.tokens.get(hashToken(token));
    if (!record || new Date(record.expiresAt).getTime() <= Date.now()) {
      return undefined;
    }
    if (record.audience !== this.config.resourceUri) {
      return undefined;
    }
    return record;
  }

  validateClient(clientId: string, redirectUri: string): boolean {
    return (
      !!this.config.oauthClientId &&
      clientId === this.config.oauthClientId &&
      this.config.oauthRedirectUris.includes(redirectUri)
    );
  }

  cleanupExpired(): void {
    const now = Date.now();
    for (const [stateId, record] of this.pendingGithubStates.entries()) {
      if (record.createdAt + 10 * 60 * 1000 < now) {
        this.pendingGithubStates.delete(stateId);
      }
    }
    for (const [codeHash, record] of this.authCodes.entries()) {
      if (record.usedAt || record.expiresAt < now) {
        this.authCodes.delete(codeHash);
      }
    }
    for (const [tokenHash, record] of this.tokens.entries()) {
      if (new Date(record.expiresAt).getTime() <= now) {
        this.tokens.delete(tokenHash);
      }
    }
  }

  private enforceLimit<T>(records: Map<string, T>, maxRecords: number, label: string): void {
    if (records.size >= maxRecords) {
      throw new AuthStoreCapacityError(label);
    }
  }
}

export function normalizeScopes(scope: string | undefined, fallbackScopes: string[]): string[] {
  const requested = (scope || fallbackScopes.join(" "))
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = requested.filter((item) => !ALL_SCOPES.includes(item as Scope));
  if (invalid.length) {
    throw new InvalidScopeError(invalid);
  }
  return requested;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = crypto.createHash("sha256").update(verifier).digest("base64url");
  if (computed.length !== challenge.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}
