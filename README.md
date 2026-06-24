# ChatGPT Local Agent MCP 🖥️

Give ChatGPT controlled hands on your Windows PC.

ChatGPT is good at thinking through work, writing code, explaining fixes, and spotting problems. But sooner or later it hits the same wall: the real project is on your computer.

The files are there.
The repo is there.
The logs are there.
The browser session is there.
The broken build is there.

**ChatGPT Local Agent MCP** is a local MCP server that lets ChatGPT reach that machine and work on the real workspace, under your control.

You run it on your Windows PC.
You expose it through your own authenticated HTTPS endpoint.
ChatGPT connects to it as a remote MCP server.

From there, ChatGPT can inspect folders, read files, apply patches, run commands, check Git status, open browser sessions, look at screenshots, inspect windows, and help operate the desktop when needed.

The simple version:

**ChatGPT stays the brain.
This gives it hands on your computer.**

For remote use, the intended setup is your own Cloudflare Tunnel and domain. That gives ChatGPT a stable HTTPS path to your local MCP server without relying on random temporary relay URLs.

This is powerful, and it should be treated that way. If the server can see a folder, browser profile, terminal, or desktop session, the connected assistant may be able to use it. Start with a dedicated workspace, keep authentication enabled, and expand access only when you understand what you are exposing.

---

## Why this exists 🚀

Most AI coding workflows still have a gap.

ChatGPT can tell you what command to run.
This lets ChatGPT help run the command.

ChatGPT can suggest a patch.
This lets ChatGPT apply the patch.

ChatGPT can ask for a log.
This lets ChatGPT inspect the log.

ChatGPT can guess from snippets.
This lets ChatGPT read the actual files.

That changes the workflow.

Instead of copying errors, files, diffs, screenshots, and terminal output back and forth, you can let ChatGPT work through the local MCP tools and keep the loop inside the real machine.

You still supervise it.
You still choose the workspace.
You still control the endpoint.
But ChatGPT is no longer blind to the place where the work actually lives.

---

## What it can help with 🧰

With the server running, ChatGPT can help with things like:

* inspect a local project
* read files and folders
* search a workspace
* compare files
* apply patches
* write or update files
* run build or diagnostic commands
* inspect Git status and diffs
* create local Git commits
* list processes and ports
* tail logs
* open browser automation sessions
* inspect browser pages
* check console and network output
* look at screenshots
* inspect windows
* use desktop mouse and keyboard actions when needed
* show local status through a dashboard

The goal is not to make ChatGPT “autonomous”.

The goal is to let ChatGPT work with the same local reality you are working with.

---

## What the setup looks like 🌍

A normal remote setup looks like this:

```text
ChatGPT
  -> your HTTPS hostname
  -> Cloudflare Tunnel
  -> http://127.0.0.1:8789
  -> local MCP server
  -> your Windows PC
```

The MCP endpoint is:

```text
https://your-public-host.example/mcp
```

The local server listens on:

```text
http://127.0.0.1:8789
```

The local dashboard is:

```text
http://127.0.0.1:8789/dashboard
```

You can run it locally first, then expose it through a tunnel only when the local health checks are clean.

If `AUTH_REQUIRED=true`, the server still needs the GitHub and ChatGPT OAuth values in `.env`, even for local testing. For localhost-only smoke checks before OAuth is configured, `AUTH_REQUIRED=false` is allowed only while the server is bound to localhost and no public tunnel is enabled.

---

## Cloudflare Tunnel basics 🌐

For ChatGPT to connect from outside your PC, the public hostname must reach your local server.

The recommended Cloudflare setup is a Tunnel, not a Worker.

In Cloudflare DNS, create a tunnel-backed record for your MCP hostname:

```text
mcp.your-domain.example -> Cloudflare Tunnel
```

In the tunnel routes, publish that hostname to the local server:

```text
https://mcp.your-domain.example -> http://127.0.0.1:8789
```

The server `.env` should then use the same public base URL:

```env
PUBLIC_BASE_URL=https://mcp.your-domain.example
CLOUDFLARE_TUNNEL_ENABLED=true
CLOUDFLARED_CONFIG=C:\Users\you\.cloudflared\config.yml
```

If the tunnel is configured but `cloudflared` is not running, Cloudflare may show the tunnel as down and the public hostname may return an error such as `530`. Start the local server and the tunnel connector before connecting ChatGPT.

---

## Start carefully ⚠️

The default workspace profile is full-machine: on Windows, the server creates profiles for the detected drive roots such as `C:\` and `D:\`.

If you want the first run limited to one test folder or repo, set a custom workspace profile before connecting ChatGPT.

Recommended first run:

1. Keep the server bound to `127.0.0.1`.
2. Keep `AUTH_REQUIRED=true` once OAuth is configured.
3. Decide whether you want full-drive access or a custom test workspace profile.
4. Use a dedicated browser profile if possible.
5. Keep shell and process access guarded until you understand the tool surface.
6. Run smoke checks.
7. Watch the local dashboard while testing.
8. Only then connect ChatGPT through the public MCP URL.

This project is intentionally capable. Treat access like you would treat a human assistant sitting at your keyboard.

---

## Known ChatGPT limits 🚧

This server can expose local tools to ChatGPT, but ChatGPT still has its own safety layer between your request and any connected tool.

Some actions may ask for confirmation or be blocked entirely: changing or deleting things, sending or posting content, using logged-in websites, exposing sensitive data, following suspicious page instructions, or anything that looks like policy evasion or unsafe automation.

Those blocks happen on the ChatGPT/OpenAI side. Making the MCP server more powerful does not bypass them.

---

## Quick start ⚡

### Requirements

* Windows
* Node.js and npm
* PowerShell or Windows PowerShell
* Git recommended
* Cloudflare Tunnel or another HTTPS tunnel if connecting from ChatGPT
* GitHub OAuth App for the authenticated remote flow

From the extracted source folder, run:

```powershell
.\Install Agentic Filesystem MCP.bat
```

The installer will guide you through the local setup.

Recommended flow:

1. Choose an install folder.
2. Install or update app files.
3. Run preflight.
4. Save `.env`.
5. Install dependencies.
6. Build the project.
7. Create shortcuts.
8. Start the server from the control menu or fallback app.
9. Run smoke checks.

The extracted source folder is not the runtime folder.

Your private `.env`, logs, data, dependencies, build output, browser artifacts, journals, backups, and screenshots belong in the install folder.

---

## Local control 🕹️

The project includes local control surfaces so you can see what is happening.

Useful local URLs and tools:

* web dashboard:

  ```text
  http://127.0.0.1:8789/dashboard
  ```

* health endpoint:

  ```text
  http://127.0.0.1:8789/healthz
  ```

* fallback PowerShell dashboard

* control menu batch file

* live monitor script

Use these before trusting the remote connector.

The dashboard exists for a reason: when an AI has tools on your machine, visibility matters.

---

## Connecting ChatGPT 🔌

The ChatGPT connector URL is the MCP endpoint:

```text
https://your-public-host.example/mcp
```

For ChatGPT to reach your local server, the endpoint must be available over HTTPS.

A typical setup uses Cloudflare Tunnel to forward your public hostname to:

```text
http://127.0.0.1:8789
```

There are two OAuth relationships. Keep them separate.

### 1. You sign in with GitHub

GitHub is used as the identity provider.

The GitHub OAuth App callback should be:

```text
https://your-public-host.example/callback
```

After GitHub login, the server checks the allowlist before issuing local MCP authorization.

### 2. ChatGPT connects as the MCP client

ChatGPT uses the local MCP OAuth configuration from `.env`:

```env
OAUTH_CLIENT_ID=
OAUTH_CLIENT_SECRET=
OAUTH_REDIRECT_URIS=
```

These are not GitHub credentials.

If the ChatGPT connector is deleted and recreated, ChatGPT may give you a new redirect URI. Update `OAUTH_REDIRECT_URIS` if that happens.

---

<details>
<summary>Maintainer and technical details 🧑‍🔧</summary>

## Project status 🧭

This is a personal, full-power local MCP system for Windows.

It is usable, but it is DIY. It is not an OS sandbox and it is not a hosted service.

The server runs with the permissions of the Windows account that starts it. If that account can read a file, launch a command, see a browser session, or interact with the desktop, the exposed tools may be able to reach the same surface.

Keep that model in mind while configuring workspaces, browser profiles, scopes, and tunnels.

---

## Architecture 🏗️

Core pieces:

* Streamable HTTP MCP server
* Express HTTP server
* GitHub OAuth identity flow
* local MCP authorization code and access token flow
* scoped MCP tools
* operation journal
* local web dashboard
* PowerShell installer
* fallback PowerShell dashboard
* optional Cloudflare Tunnel exposure

Runtime defaults:

```text
Server:     http://127.0.0.1:8789
MCP:        http://127.0.0.1:8789/mcp
Dashboard: http://127.0.0.1:8789/dashboard
```

Normal install root:

```text
%LOCALAPPDATA%\AgenticFilesystemMCP
```

---

## Tool surface 🧰

The server registers tools across these categories:

* workspace information
* filesystem read, write, patch, copy, move, delete, search, hash, tree, stat
* Git status, diff, commit
* process start, stop, kill, port list, log tail, wait for port
* shell execution
* browser sessions, navigation, snapshots, console, network, screenshots, CDP attach
* screen, OCR hook, and window listing
* desktop mouse and keyboard automation

Tool access is controlled by MCP scopes:

```text
mcp:read
mcp:write
mcp:shell
mcp:git
mcp:patch
mcp:delete
mcp:process
mcp:screen
mcp:desktop
mcp:browser
```

Use narrow scopes when possible. Add power only when you need it.

---

## Configuration ⚙️

Create a private `.env` from `.env.example`.

Full-power local defaults from `.env.example`:

```env
GPT_FS_MCP_HOST=127.0.0.1
GPT_FS_MCP_PORT=8789
GPT_FS_MCP_MAX_POLICY_MODE=destructive
GPT_FS_MCP_ENFORCE_WORKSPACE_PROFILES=true
GPT_FS_MCP_SHELL_POLICY=full
GPT_FS_MCP_PROCESS_POLICY=full
AUTH_REQUIRED=true
NODE_ENV=development
```

For a safer first workspace, define `GPT_FS_MCP_WORKSPACE_PROFILES_JSON` for one test folder, keep auth enabled, and guard command execution:

```env
GPT_FS_MCP_SHELL_POLICY=workspace_guarded
GPT_FS_MCP_PROCESS_POLICY=workspace_guarded
```

Use `full` command policies only when you deliberately want shell and process tools to reach outside declared workspace paths.

For a public or tunneled connector:

```env
AUTH_REQUIRED=true
CLOUDFLARE_TUNNEL_ENABLED=true
PUBLIC_BASE_URL=https://your-public-host.example
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
ALLOWED_GITHUB_LOGINS=your-github-login
OAUTH_CLIENT_ID=
OAUTH_CLIENT_SECRET=
OAUTH_REDIRECT_URIS=
```

Never expose the server with:

```env
AUTH_REQUIRED=false
```

The code rejects unsafe combinations such as public HTTPS with `AUTH_REQUIRED=false`, but configuration still matters. Treat `.env` as security-critical.

---

## OAuth model 🔐

There are two OAuth layers.

### GitHub OAuth App → MCP server

You sign in with GitHub.

The server redirects to GitHub, receives the callback, checks the allowed GitHub login, and then issues a local MCP authorization code.

GitHub callback:

```text
https://your-public-host.example/callback
```

Relevant config:

```env
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
ALLOWED_GITHUB_LOGINS=
```

### ChatGPT connector → MCP server

ChatGPT is the OAuth client talking to this MCP server.

Relevant config:

```env
OAUTH_CLIENT_ID=
OAUTH_CLIENT_SECRET=
OAUTH_REDIRECT_URIS=
```

The server exposes OAuth metadata at:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
```

The server does not expose dynamic client registration.

---

## Cloudflare Tunnel model 🌐

The intended remote exposure model is:

```text
ChatGPT
  -> https://mcp.your-domain.example/mcp
  -> Cloudflare Tunnel
  -> http://127.0.0.1:8789
  -> local MCP server
```

No Cloudflare Worker is required for the normal setup.

For a locally managed Cloudflare Tunnel, the dashboard route is read from the local `cloudflared` configuration file. A minimal route looks like:

```yaml
ingress:
  - hostname: mcp.your-domain.example
    service: http://127.0.0.1:8789
  - service: http_status:404
```

The matching `.env` values are:

```env
PUBLIC_BASE_URL=https://mcp.your-domain.example
CLOUDFLARE_TUNNEL_ENABLED=true
CLOUDFLARED_CONFIG=C:\Users\you\.cloudflared\config.yml
```

If Cloudflare shows the DNS record as a Tunnel but the tunnel status is `Down` with `0` active replicas, the dashboard configuration can still be correct. It means the local `cloudflared` connector is not currently connected.

---

## Security boundaries 🧱

This system is designed to be capable, not sandboxed.

Boundaries it does provide:

* OAuth controls who can connect.
* GitHub login allowlisting controls who can complete auth.
* MCP scopes control tool categories.
* policy modes limit which tools are available.
* workspace profiles can restrict filesystem paths.
* command policies can restrict shell/process behavior.
* journals and logs redact common secret-looking fields.

Boundaries it does not provide:

* It is not an OS sandbox.
* Browser CDP attach can interact with existing browser profiles and logged-in sessions.
* Desktop tools can move the mouse and press keys.
* Shell and process tools run with the local server process permissions.
* An authorized assistant may still read or reveal accessible local secrets if you expose them through files, browser state, desktop, or shell.

For stricter command behavior:

```env
GPT_FS_MCP_SHELL_POLICY=workspace_guarded
GPT_FS_MCP_PROCESS_POLICY=workspace_guarded
```

`workspace_guarded` checks the command working directory plus explicit path references and expected touched paths.

It is still not a sandbox.

---

## Workspace profiles 📁

By default, when `GPT_FS_MCP_WORKSPACE_PROFILES_JSON` is empty, the server creates one workspace profile per detected filesystem root.

On Windows, that means available drive roots such as:

```text
C:\
D:\
```

That is intentional full-machine access.

`GPT_FS_MCP_DEFAULT_CWD` only controls the starting directory for relative paths and commands. If it is empty, it falls back to the user `Documents\GitHub` folder. It does not limit filesystem access by itself.

Custom workspace profiles can be provided with:

```env
GPT_FS_MCP_WORKSPACE_PROFILES_JSON=
```

Profiles define:

* root path
* allowed policy modes
* backup policy
* secret deny globs

Use profiles to keep the assistant inside the intended workspace instead of exposing more of the machine than necessary.

---

## Browser, screen, and desktop notes 🌐

Browser automation uses Playwright.

If browser binaries are missing after dependency install, run:

```powershell
npx playwright install
```

Browser and desktop tools are high-risk because they can interact with visible UI and active sessions.

Use a dedicated browser profile when possible.

Do not attach the server to accounts, profiles, or desktop sessions you are not willing to expose to the connected assistant.

---

## Development 🧪

Install dependencies:

```powershell
npm ci
```

Type-check:

```powershell
npm run type-check
```

Build:

```powershell
npm run build
```

Run tests:

```powershell
npm test
```

Run the built server:

```powershell
npm start
```

Run in watch mode:

```powershell
npm run dev
```

---

## Publish-safe check 🧼

Before sharing the source folder:

```powershell
npm run audit:publish-safe
```

The source repo should not include:

* `.env`
* `data/`
* `node_modules/`
* `dist/`
* `*.log`
* runtime screenshots
* browser artifacts
* journals
* backups

The included `.gitignore` excludes the main repo-root runtime directories and logs. Run the publish-safe audit before publishing; it is the final check, not the ignore file alone.

---

## Troubleshooting 🩺

### `/mcp` returns 401

That is normal without a token.

A protected MCP endpoint should reject unauthenticated requests.

---

### `/authorize` returns `invalid_request`

Usually one of these does not match the ChatGPT connector request:

* `OAUTH_CLIENT_ID`
* `OAUTH_REDIRECT_URIS`
* `PUBLIC_BASE_URL`
* requested `resource`
* PKCE settings

---

### `/callback` works but `/token` returns 401

The ChatGPT connector secret does not match:

```env
OAUTH_CLIENT_SECRET=
```

or ChatGPT is not sending the expected client credentials.

---

### GitHub login succeeds but ChatGPT does not connect

Keep the two OAuth layers separate:

GitHub callback:

```text
https://your-public-host.example/callback
```

ChatGPT connector URL:

```text
https://your-public-host.example/mcp
```

ChatGPT redirect URI:

```env
OAUTH_REDIRECT_URIS=
```

Do not put the ChatGPT redirect URI into the GitHub OAuth App.

---

### Browser automation fails

Check whether Playwright browsers are installed:

```powershell
npx playwright install
```

Also check whether the server is running under the Windows account that owns the browser/profile you expect to use.

---

### Public hostname returns Cloudflare 530

The Cloudflare DNS and tunnel route may be correct, but the local tunnel connector is not connected.

Check that:

* the MCP server is listening on `http://127.0.0.1:8789`
* `cloudflared` is running
* the tunnel dashboard shows at least one active replica
* the tunnel route points to `http://127.0.0.1:8789`

---

### ChatGPT can read but cannot perform a browser or desktop action

The local MCP server may be working correctly.

ChatGPT/OpenAI safety layers can still block some write, submit, send, post, authenticated browser, or desktop actions.

Treat this as a platform boundary first, then inspect server logs.

---

</details>

---

## License

MIT. See [LICENSE](LICENSE).
