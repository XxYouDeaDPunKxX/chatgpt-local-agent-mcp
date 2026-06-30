# Install

This project has two setup paths. Use them in order.

Do **Path A** first, even if your final goal is to connect ChatGPT remotely.

---

## Path A — local-only smoke test

Use this first.

Goal: prove that the local server starts, the dashboard opens, and health checks pass.

This does **not** connect ChatGPT yet.

```text
No Cloudflare.
No public URL.
No GitHub OAuth App.
No ChatGPT connector OAuth.
No remote connector.
```

### Requirements

* Windows
* Node.js and npm
* PowerShell or Windows PowerShell
* Git recommended

### 1. Run the installer

From the extracted source folder:

```powershell
.\install-chatgpt-local-agent-mcp.bat
```

The extracted source folder is not the runtime folder. The installer copies the app into the install folder and builds it there.

Default install folder:

```text
%LOCALAPPDATA%\chatgpt-local-agent-mcp
```

### 2. Install app files

In the installer, choose the install folder, then click:

```text
Install/Update App Files
```

This copies the public app files into the runtime folder.

### 3. Run preflight

Click:

```text
Run Preflight
```

If required files are missing, install/update app files first.

### 4. Configure `.env` for localhost-only smoke testing

Open the `Configuration` tab.

For the first local-only smoke test, use:

```text
Auth required: off
Tunnel enabled: off
Public base URL: http://127.0.0.1:8789
```

Equivalent `.env` values:

```env
PUBLIC_BASE_URL=http://127.0.0.1:8789
CLOUDFLARE_TUNNEL_ENABLED=false
AUTH_REQUIRED=false
```

Then click:

```text
Save .env
```

This configuration is allowed only for localhost development with no tunnel.

Do **not** use `AUTH_REQUIRED=false` with a public URL, public hostname, or Cloudflare Tunnel.

### 5. Install dependencies and build

Click:

```text
Install Dependencies + Build
```

This runs:

```powershell
npm ci
npm run build
```

The step is intended to be re-runnable for repair/update flows.

### 6. Create shortcuts

Click:

```text
Create Shortcuts
```

This creates Desktop and Start Menu shortcuts for local control surfaces.

### 7. Open control and start the local server

Click:

```text
Open Control
```

Use the control menu or fallback app to start the local server.

### 8. Open the local dashboard

Open:

```text
http://127.0.0.1:8789/dashboard
```

Health endpoint:

```text
http://127.0.0.1:8789/healthz
```

### 9. Run smoke checks

In the installer, click:

```text
Run Smoke Checks
```

A useful first success means:

```text
server starts
health endpoint responds
dashboard opens
build output exists
local control surfaces are usable
```

At this point, you have not connected ChatGPT yet. That is intentional.

---

## Path B — full remote ChatGPT connector

Use this only after Path A works.

Goal: connect ChatGPT to your local MCP server through an authenticated HTTPS endpoint.

This path is deliberately more explicit because it connects a remote client to local machine capabilities.

### Additional requirements

* Cloudflare Tunnel or another HTTPS tunnel
* GitHub OAuth App
* ChatGPT connector OAuth values
* public HTTPS MCP endpoint
* GitHub login allowlist

### Target architecture

```text
ChatGPT
  -> https://your-public-host.example/mcp
  -> Cloudflare Tunnel
  -> http://127.0.0.1:8789
  -> local MCP server
  -> your Windows PC
```

### 1. Configure the public base URL

Example:

```env
PUBLIC_BASE_URL=https://mcp.your-domain.example
CLOUDFLARE_TUNNEL_ENABLED=true
CLOUDFLARED_CONFIG=C:\Users\you\.cloudflared\config.yml
```

### 2. Enable auth for remote use

Remote use should keep auth enabled:

```env
AUTH_REQUIRED=true
```

Never expose the server publicly with:

```env
AUTH_REQUIRED=false
```

The installer/server reject unsafe combinations such as auth disabled with a public URL or enabled tunnel, but you should still treat `.env` as security-critical.

### 3. Configure GitHub OAuth

GitHub is used as the identity provider for user login.

GitHub OAuth App callback:

```text
https://your-public-host.example/callback
```

Relevant `.env` values:

```env
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
ALLOWED_GITHUB_LOGINS=your-github-login
```

### 4. Configure ChatGPT connector OAuth

ChatGPT is the MCP OAuth client.

Relevant `.env` values:

```env
OAUTH_CLIENT_ID=
OAUTH_CLIENT_SECRET=
OAUTH_REDIRECT_URIS=
```

These are not GitHub credentials.

If you delete and recreate the ChatGPT connector, ChatGPT may provide a different redirect URI. Update `OAUTH_REDIRECT_URIS` if that happens.

### 5. Start the local server and tunnel

Before connecting ChatGPT, verify:

```text
local server is listening on http://127.0.0.1:8789
cloudflared is running
public hostname reaches the local server
dashboard/health checks are clean
```

### 6. Connect ChatGPT

Use the MCP endpoint:

```text
https://your-public-host.example/mcp
```

If `/mcp` returns `401` without a token, that is normal for a protected MCP endpoint.

---

## Safer first workspace

By default, when no custom workspace profile is configured, the server creates profiles for detected drive roots such as `C:\` and `D:\`.

That is full-machine style access.

For the first serious test, use one dedicated folder or repo before expanding access.

Useful policy values:

```env
GPT_FS_MCP_SHELL_POLICY=workspace_guarded
GPT_FS_MCP_PROCESS_POLICY=workspace_guarded
```

Use full shell/process policies only when you deliberately want that power.

---

## Common first-run problems

### Save `.env` asks for OAuth values

That means `AUTH_REQUIRED=true`.

For Path A local-only smoke testing, use:

```env
PUBLIC_BASE_URL=http://127.0.0.1:8789
CLOUDFLARE_TUNNEL_ENABLED=false
AUTH_REQUIRED=false
```

Only use that combination on localhost with no tunnel.

### `/mcp` returns `401`

That is normal without a token.

A protected MCP endpoint should reject unauthenticated requests.

### Public hostname returns Cloudflare `530`

Usually the tunnel route exists, but the local tunnel connector is not running.

Check that:

```text
MCP server is running on http://127.0.0.1:8789
cloudflared is running
tunnel has active replicas
tunnel route points to http://127.0.0.1:8789
```

### Browser automation fails

Install Playwright browser binaries:

```powershell
npx playwright install
```

Also make sure the server is running under the Windows account that owns the browser/profile you expect to use.

---

## What not to do

Do not expose a public URL with auth disabled.

Do not connect ChatGPT before the local dashboard and health checks work.

Do not start with full-machine access if you only need one repo.

Do not use your everyday browser profile for risky testing if a dedicated profile is enough.

Do not treat this like a casual one-click toy. The first local test should be simple; the remote connector setup should remain deliberate.
