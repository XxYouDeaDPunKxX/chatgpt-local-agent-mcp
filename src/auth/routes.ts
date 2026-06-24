import express, { NextFunction, Request, Response } from "express";
import { AppConfig } from "../config.js";
import { ALL_SCOPES } from "../scopes.js";
import {
  AuthStore,
  AuthStoreCapacityError,
  InvalidScopeError,
  PendingAuthorizeRecord,
  normalizeScopes,
  verifyPkceS256,
} from "./store.js";

type GithubUser = {
  id: number;
  login: string;
  name?: string;
};

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

function redirectWithError(redirectUri: string, state: string, error: string, description: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  url.searchParams.set("state", state);
  return url.href;
}

function oauthAuthorizeError(
  res: Response,
  store: AuthStore,
  clientId: string,
  redirectUri: string,
  state: string,
  error: string,
  description: string,
): void {
  if (store.validateClient(clientId, redirectUri)) {
    res.redirect(redirectWithError(redirectUri, state, error, description));
    return;
  }

  res.status(400).json({
    error: "invalid_request",
    error_description: "Authorization request is invalid",
  });
}

function oauthBrowserError(res: Response, status: number): void {
  res.status(status).type("html").send("<!doctype html><title>OAuth failed</title><p>OAuth callback failed.</p>");
}

type ClientCredentials = {
  clientId?: string;
  clientSecret?: string;
  malformed?: boolean;
};

function rateLimitKey(req: Request): string {
  const cfConnectingIp = req.headers["cf-connecting-ip"];
  if (req.app.locals.cloudflareTunnelEnabled === true && typeof cfConnectingIp === "string" && cfConnectingIp) {
    return cfConnectingIp;
  }

  const forwardedFor = req.headers["x-forwarded-for"];
  if (req.app.locals.trustProxyHeaders === true && typeof forwardedFor === "string" && forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.ip || req.socket.remoteAddress || "unknown";
}

function createRateLimiter(config: AppConfig) {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  function cleanupExpiredBuckets(now: number): void {
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = `${req.path}:${rateLimitKey(req)}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (buckets.size >= config.authRateLimitMaxBuckets) {
        cleanupExpiredBuckets(now);
      }
      if (buckets.size >= config.authRateLimitMaxBuckets) {
        res
          .status(503)
          .set("Retry-After", String(Math.ceil(config.authRateLimitWindowMs / 1000)))
          .json({ error: "temporarily_unavailable" });
        return;
      }
      buckets.set(key, { count: 1, resetAt: now + config.authRateLimitWindowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > config.authRateLimitMax) {
      res
        .status(429)
        .set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)))
        .json({ error: "rate_limited" });
      return;
    }

    next();
  };
}

function temporaryUnavailable(res: Response, error: unknown): boolean {
  if (!(error instanceof AuthStoreCapacityError)) {
    return false;
  }

  res.status(503).json({
    error: "temporarily_unavailable",
    error_description: error.message,
  });
  return true;
}

function safeDecodeFormComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return undefined;
  }
}

function clientCredentials(req: Request): ClientCredentials {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) {
      return { malformed: true };
    }
    const clientId = safeDecodeFormComponent(decoded.slice(0, separator));
    const clientSecret = safeDecodeFormComponent(decoded.slice(separator + 1));
    if (clientId === undefined || clientSecret === undefined) {
      return { malformed: true };
    }
    return { clientId, clientSecret };
  }

  return {
    clientId: typeof req.body.client_id === "string" ? req.body.client_id : undefined,
    clientSecret: typeof req.body.client_secret === "string" ? req.body.client_secret : undefined,
  };
}

async function exchangeGithubCode(config: AppConfig, code: string): Promise<string> {
  if (!config.githubClientId || !config.githubClientSecret) {
    throw new Error("GitHub OAuth is not configured");
  }

  const response = await fetch("https://github.com/login/oauth/access_token", {
    body: new URLSearchParams({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      redirect_uri: new URL("/callback", config.publicBaseUrl).href,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`GitHub token exchange failed: ${response.status}`);
  }
  const body = (await response.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) {
    throw new Error(body.error_description || "GitHub token exchange returned no access token");
  }
  return body.access_token;
}

async function getGithubUser(accessToken: string): Promise<GithubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "gpt-file-system-mcp",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub user fetch failed: ${response.status}`);
  }
  return (await response.json()) as GithubUser;
}

export function registerAuthRoutes(app: express.Express, config: AppConfig, store: AuthStore): void {
  app.locals.cloudflareTunnelEnabled = config.cloudflareTunnelEnabled;
  app.locals.trustProxyHeaders = config.trustProxyHeaders;
  const authRateLimit = createRateLimiter(config);

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      authorization_servers: [config.publicBaseUrl],
      resource: config.resourceUri,
      scopes_supported: ALL_SCOPES,
    });
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      authorization_endpoint: new URL("/authorize", config.publicBaseUrl).href,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code"],
      issuer: config.publicBaseUrl,
      response_types_supported: ["code"],
      scopes_supported: ALL_SCOPES,
      token_endpoint: new URL("/token", config.publicBaseUrl).href,
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    });
  });

  app.get("/authorize", authRateLimit, (req, res) => {
    const responseType = req.query.response_type;
    const clientId = typeof req.query.client_id === "string" ? req.query.client_id : "";
    const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const resource = typeof req.query.resource === "string" ? req.query.resource : "";
    const codeChallenge = typeof req.query.code_challenge === "string" ? req.query.code_challenge : undefined;
    const codeChallengeMethod =
      req.query.code_challenge_method === "S256" ? "S256" : req.query.code_challenge_method ? undefined : undefined;

    if (responseType !== "code") {
      oauthAuthorizeError(res, store, clientId, redirectUri, state, "unsupported_response_type", "Unsupported response_type");
      return;
    }
    if (!state) {
      oauthAuthorizeError(res, store, clientId, redirectUri, state, "invalid_request", "state is required");
      return;
    }
    if (!resource || resource !== config.resourceUri) {
      oauthAuthorizeError(res, store, clientId, redirectUri, state, "invalid_target", "Invalid resource");
      return;
    }
    if (!store.validateClient(clientId, redirectUri)) {
      oauthAuthorizeError(res, store, clientId, redirectUri, state, "invalid_request", "Invalid client_id or redirect_uri");
      return;
    }
    if (req.query.code_challenge_method && codeChallengeMethod !== "S256") {
      oauthAuthorizeError(res, store, clientId, redirectUri, state, "invalid_request", "Only S256 PKCE is supported");
      return;
    }
    if (config.authRequirePkce && (!codeChallenge || codeChallengeMethod !== "S256")) {
      oauthAuthorizeError(res, store, clientId, redirectUri, state, "invalid_request", "PKCE S256 is required");
      return;
    }
    if (codeChallenge && codeChallengeMethod !== "S256") {
      oauthAuthorizeError(res, store, clientId, redirectUri, state, "invalid_request", "Only S256 PKCE is supported");
      return;
    }

    let requestedScopes: string[];
    try {
      requestedScopes = normalizeScopes(
        typeof req.query.scope === "string" ? req.query.scope : undefined,
        config.defaultOauthScopes,
      );
    } catch (error) {
      if (error instanceof InvalidScopeError) {
        oauthAuthorizeError(res, store, clientId, redirectUri, state, "invalid_scope", error.message);
        return;
      }
      throw error;
    }

    if (!config.githubClientId) {
      console.error("GitHub OAuth is not configured");
      oauthAuthorizeError(res, store, clientId, redirectUri, state, "server_error", "Authorization server is unavailable");
      return;
    }

    let githubState: string;
    try {
      githubState = store.createPendingAuthorize({
        clientId,
        codeChallenge,
        codeChallengeMethod,
        redirectUri,
        resource,
        scope: requestedScopes,
        state,
      });
    } catch (error) {
      if (temporaryUnavailable(res, error)) return;
      throw error;
    }

    const githubUrl = new URL("https://github.com/login/oauth/authorize");
    githubUrl.searchParams.set("client_id", config.githubClientId);
    githubUrl.searchParams.set("redirect_uri", new URL("/callback", config.publicBaseUrl).href);
    githubUrl.searchParams.set("response_type", "code");
    githubUrl.searchParams.set("scope", "read:user");
    githubUrl.searchParams.set("state", githubState);
    res.redirect(githubUrl.href);
  });

  app.get("/callback", authRateLimit, asyncRoute(async (req, res) => {
    let pending: PendingAuthorizeRecord | undefined;
    try {
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const code = typeof req.query.code === "string" ? req.query.code : "";
      pending = store.consumePendingAuthorize(state);
      if (!pending || !code) {
        oauthBrowserError(res, 400);
        return;
      }

      const githubAccessToken = await exchangeGithubCode(config, code);
      const user = await getGithubUser(githubAccessToken);
      if (!config.allowedGithubLogins.includes(user.login.toLowerCase())) {
        res.redirect(redirectWithError(pending.redirectUri, pending.state, "access_denied", "GitHub user not allowed"));
        return;
      }

      let authCode: string;
      try {
        authCode = store.createAuthCode({
          ...pending,
          login: user.login,
          subject: `github:${user.id}`,
        });
      } catch (error) {
        if (temporaryUnavailable(res, error)) return;
        throw error;
      }
      const redirectUri = new URL(pending.redirectUri);
      redirectUri.searchParams.set("code", authCode);
      redirectUri.searchParams.set("state", pending.state);
      res.redirect(redirectUri.href);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("GitHub OAuth callback failed:", message);
      if (pending) {
        res.redirect(redirectWithError(pending.redirectUri, pending.state, "server_error", "OAuth callback failed"));
        return;
      }
      oauthBrowserError(res, 500);
    }
  }));

  app.post("/token", authRateLimit, (req, res) => {
    const { clientId, clientSecret, malformed } = clientCredentials(req);
    if (
      malformed ||
      !clientId ||
      !clientSecret ||
      clientId !== config.oauthClientId ||
      clientSecret !== config.oauthClientSecret
    ) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }

    if (req.body.grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }

    const code = typeof req.body.code === "string" ? req.body.code : "";
    const redirectUri = typeof req.body.redirect_uri === "string" ? req.body.redirect_uri : "";
    const requestedResource = typeof req.body.resource === "string" ? req.body.resource : undefined;
    const codeRecord = store.getAuthCode(code);
    if (!codeRecord) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    if (
      codeRecord.clientId !== clientId ||
      codeRecord.redirectUri !== redirectUri ||
      (requestedResource && codeRecord.resource !== requestedResource)
    ) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    if (codeRecord.resource !== config.resourceUri) {
      res.status(400).json({ error: "invalid_target" });
      return;
    }
    if (codeRecord.codeChallenge) {
      const verifier = typeof req.body.code_verifier === "string" ? req.body.code_verifier : "";
      if (!verifier || !verifyPkceS256(verifier, codeRecord.codeChallenge)) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
    }

    let issued: { expiresIn: number; token: string };
    try {
      issued = store.issueAccessToken({
        audience: config.resourceUri,
        login: codeRecord.login,
        scopes: codeRecord.scope,
        subject: codeRecord.subject,
      });
    } catch (error) {
      if (temporaryUnavailable(res, error)) return;
      throw error;
    }
    store.markAuthCodeUsed(code);
    res.json({
      access_token: issued.token,
      expires_in: issued.expiresIn,
      scope: codeRecord.scope.join(" "),
      token_type: "Bearer",
    });
  });
}
