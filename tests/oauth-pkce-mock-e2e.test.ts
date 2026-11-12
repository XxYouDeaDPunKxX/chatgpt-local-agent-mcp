import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { AppConfig } from "../src/config.js";
import { registerAuthRoutes } from "../src/auth/routes.js";
import { AuthStore } from "../src/auth/store.js";

test("OAuth authorization-code PKCE round trip with local GitHub HTTP stubs", { timeout: 20_000 }, async () => {
  const realFetch = globalThis.fetch;
  let githubRequests = 0;
  let mockLogin = "synthetic-user";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    if (url === "https://github.com/login/oauth/access_token") {
      githubRequests++;
      assert.equal(init?.method, "POST");
      const body = init?.body as URLSearchParams;
      assert.equal(body.get("client_secret"), "synthetic-github-secret");
      return Response.json({ access_token: "synthetic-github-token" });
    }
    if (url === "https://api.github.com/user") {
      githubRequests++;
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-github-token");
      return Response.json({ login: mockLogin, id: 4242 });
    }
    throw new Error("Unexpected external URL in OAuth test: " + url);
  }) as typeof fetch;

  const config = {
    authRateLimitMaxBuckets: 10,
    authRateLimitMax: 60,
    authRateLimitWindowMs: 30_000,
    authStoreCleanupIntervalMs: 60_000,
    authStoreMaxAuthCodes: 40,
    authStoreMaxPending: 40,
    authStoreMaxTokens: 40,
    authRequirePkce: true,
    defaultOauthScopes: ["mcp:read"],
    githubClientId: "synthetic-github-client",
    githubClientSecret: "synthetic-github-secret",
    oauthClientId: "synthetic-mcp-client",
    oauthClientSecret: "synthetic-mcp-secret",
    oauthRedirectUris: ["http://127.0.0.1:33333/callback"],
    allowedGithubLogins: ["synthetic-user"],
    publicBaseUrl: "",
    resourceUri: "",
    cloudflareTunnelEnabled: false,
    trustProxyHeaders: false,
  } as AppConfig;

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  const store = new AuthStore(config);
  registerAuthRoutes(app, config, store);
  const server = http.createServer(app);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    config.publicBaseUrl = base;
    config.resourceUri = base + "/mcp";
    const verifier = "synthetic-oauth-verifier-with-enough-entropy";
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const callbackUri = config.oauthRedirectUris[0];
    const begin = async (state: string) => {
      const url = new URL(base + "/authorize");
      url.search = new URLSearchParams({
        client_id: config.oauthClientId!, redirect_uri: callbackUri,
        response_type: "code", state, resource: config.resourceUri,
        code_challenge: challenge, code_challenge_method: "S256", scope: "mcp:read",
      }).toString();
      const response = await realFetch(url, { redirect: "manual" });
      assert.equal(response.status, 302);
      const github = new URL(response.headers.get("location")!);
      assert.equal(github.hostname, "github.com");
      return github.searchParams.get("state")!;
    };
    const state = await begin("client-state");
    const callback = await realFetch(new URL(base + "/callback?code=synthetic-code&state=" + encodeURIComponent(state)), { redirect: "manual" });
    assert.equal(callback.status, 302);
    const redirected = new URL(callback.headers.get("location")!);
    assert.equal(redirected.origin, new URL(callbackUri).origin);
    assert.equal(redirected.searchParams.get("state"), "client-state");
    const code = redirected.searchParams.get("code");
    assert.ok(code);
    const token = async (codeVerifier: string) => {
      return realFetch(base + "/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.oauthClientId!, client_secret: config.oauthClientSecret!,
          code: code!, code_verifier: codeVerifier, redirect_uri: callbackUri,
          resource: config.resourceUri, grant_type: "authorization_code",
        }),
      });
    };
    const denied = await token("incorrect-verifier");
    assert.equal(denied.status, 400);
    assert.equal((await denied.json() as {error:string}).error, "invalid_grant");
    const allowed = await token(verifier);
    assert.equal(allowed.status, 200);
    const payload = await allowed.json() as { access_token: string; token_type: string; scope: string };
    assert.equal(payload.token_type, "Bearer");
    assert.equal(payload.scope, "mcp:read");
    assert.ok(store.getAccessToken(payload.access_token));
    const replay = await token(verifier);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json() as {error:string}).error, "invalid_grant");

    mockLogin = "forbidden-user";
    const anotherState = await begin("denied-user");
    const blocked = await realFetch(base + "/callback?code=synthetic-code&state=" + encodeURIComponent(anotherState), { redirect: "manual" });
    assert.equal(blocked.status, 302);
    const blockedLocation = new URL(blocked.headers.get("location")!);
    assert.equal(blockedLocation.searchParams.get("error"), "access_denied");
    assert.equal(blockedLocation.searchParams.has("code"), false);
    assert.equal(githubRequests, 4);
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
