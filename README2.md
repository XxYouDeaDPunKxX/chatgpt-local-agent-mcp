# chatgpt-local-agent-mcp

Give ChatGPT supervised, policy-gated access to the files, tools, browser sessions, and desktop state on a Windows PC.

ChatGPT remains the remote client and reasoning layer. This project runs locally under your Windows account and exposes selected capabilities through MCP.

> [!CAUTION]
> This is a **full-power local tool, not an OS sandbox**. The example configuration enables every OAuth scope, allows destructive policy mode, uses full shell/process policies, and creates workspace profiles for detected filesystem roots when no custom profile is supplied. Start locally, restrict the workspace, and widen access deliberately.

|                           |                                                           |
| ------------------------- | --------------------------------------------------------- |
| **Runs on**               | Windows, Node.js, PowerShell                              |
| **First verified result** | Local dashboard opens and `/healthz` responds             |
| **Remote path**           | ChatGPT → authenticated HTTPS MCP endpoint → local server |
| **Local authority**       | The Windows account that starts the server                |
| **Project status**        | Personal/DIY, version `0.1.0`, not a hosted service       |

## Start here

There are two setup paths. Use them in order.

### Path A — local-only smoke test

Do this first. It proves the installer, build, server, dashboard, and health endpoint work without connecting ChatGPT or exposing a public URL.

#### Requirements

* Windows
* Node.js and npm
* PowerShell or Windows PowerShell
* Git recommended

#### 1. Launch the installer

From the extracted source folder:

```powershell
.\install-chatgpt-local-agent-mcp.bat
```

The installer copies the public app files into a separate runtime folder and builds there.

Default runtime folder:

```text
%LOCALAPPDATA%\chatgpt-local-agent-mcp
```

**Expected result:** the WinForms installer opens. The source folder remains separate from runtime data and secrets.

#### 2. Install and preflight

In the installer:

1. select **Install/Update App Files**;
2. run **Preflight**;
3. open the **Configuration** tab.

**Expected result:** required files are present and the installer reports what still needs configuration.

#### 3. Use localhost-only configuration

For the first smoke test:

```env
PUBLIC_BASE_URL=http://127.0.0.1:8789
CLOUDFLARE_TUNNEL_ENABLED=false
AUTH_REQUIRED=false
```

Then save `.env`, install dependencies, and build.

`AUTH_REQUIRED=false` is accepted only for local development bound to loopback with no HTTPS public URL and no tunnel. The server rejects unsafe combinations.

#### 4. Start the server and verify it

Open the local control surface and start the server, then visit:

```text
Dashboard: http://127.0.0.1:8789/dashboard
Health:    http://127.0.0.1:8789/healthz
```

**First success means:**

```text
server starts
health endpoint responds
dashboard opens
build output exists
local controls are usable
```

At this point ChatGPT is **not connected**. That is intentional.

For the full click-by-click procedure, use [INSTALL.md](INSTALL.md).

---

### Path B — authenticated remote ChatGPT connector

Use this only after Path A works.

```text
ChatGPT
  -> https://your-public-host.example/mcp
  -> Cloudflare Tunnel or another HTTPS tunnel
  -> http://127.0.0.1:8789
  -> local MCP server
  -> your Windows PC
```

Additional requirements:

* a public HTTPS hostname;
* Cloudflare Tunnel or another HTTPS tunnel;
* a GitHub OAuth App for user identity;
* OAuth client values for the ChatGPT connector;
* a GitHub login allowlist.

Before exposing the endpoint remotely:

* define a custom workspace profile for one test folder;
* reduce OAuth scopes to the tool categories you actually need;
* prefer `workspace_guarded` shell and process policies;
* keep `AUTH_REQUIRED=true`;
* use a dedicated browser profile when possible;
* watch the local dashboard during the first sessions.

A good first remote request is read-only:

```text
Inspect only the configured test workspace. Show its top-level tree and Git status.
Do not modify files, start processes, open a browser, or use desktop controls.
```

**Expected result:** ChatGPT can inspect the declared workspace but cannot perform actions outside the granted scopes and policy modes.

## What it can expose

Capabilities are grouped by MCP scope and policy mode. Availability depends on both.

| Surface             | Examples                                                                             | Important boundary                                                             |
| ------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Workspace and files | tree, search, stat, read, hash                                                       | Files can contain secrets; workspace profiles and deny globs matter.           |
| File changes        | write, patch, copy, move, delete, rollback                                           | Mutations require write/delete/patch scope and an allowed policy mode.         |
| Git                 | status, diff, local commit                                                           | Commit is a destructive-policy operation; this project does not push or merge. |
| Shell and processes | run commands, start/stop processes, inspect ports and logs                           | Commands run with the local server account's permissions.                      |
| Browser             | Playwright sessions, navigation, snapshots, console/network, screenshots, CDP attach | CDP attachment may reach an existing logged-in browser profile.                |
| Screen and desktop  | window list, screenshot, OCR hook, mouse, keyboard, typing                           | Desktop actions affect the active Windows session.                             |
| Local observability | dashboard, journal, backups, live monitor                                            | A journal improves traceability; it is not a security boundary by itself.      |

## How control is applied

| Control                  | What it governs                                                     |
| ------------------------ | ------------------------------------------------------------------- |
| GitHub login allowlist   | Who may complete remote authentication                              |
| OAuth scopes             | Which tool categories a connection can request                      |
| Maximum policy mode      | The highest action class the server will register or execute        |
| Workspace profiles       | Which filesystem roots and policy modes are allowed                 |
| Secret deny globs        | Paths that file and command guards should reject                    |
| Shell/process policy     | Disabled, workspace-guarded, or full command reach                  |
| Dry-run and confirmation | Preview and explicit confirmation for supported destructive tools   |
| Journal and backups      | Durable operation trace and file-level recovery for supported tools |

These controls reduce risk; they do not turn the process into a sandbox. Service-side permissions and the Windows account remain the final blast radius.

## Recommended progression

1. Prove the localhost dashboard and health endpoint work.
2. Create one disposable test repo or folder.
3. Configure a custom workspace profile for that folder.
4. Connect remotely with read-only scopes and a low maximum policy mode.
5. Test `workspace_info`, tree, read, Git status, and Git diff.
6. Add patch/write access only when needed.
7. Add shell, process, browser, screen, or desktop access one category at a time.
8. Review the journal and backup behavior before using real projects or logged-in sessions.

## What this project is not

* It is not an OS sandbox or virtual machine.
* It is not a hosted multi-user service.
* It is not a way to bypass ChatGPT or OpenAI safety controls.
* It is not safe to expose anonymously or with `AUTH_REQUIRED=false` over a tunnel.
* It does not make ChatGPT autonomous; the goal is supervised access to real local context.
* It does not make accessible files, browser sessions, or desktop state non-sensitive.

## Known ChatGPT limits

The MCP server can expose a tool, but ChatGPT still applies its own safety layer before using it.

Some writes, submissions, messages, logged-in browser actions, sensitive-data operations, and desktop actions may require confirmation or be blocked. Increasing the local server's power does not override those platform boundaries.

## Documentation

* [Full installation guide](INSTALL.md)
* [Configuration template](.env.example)
* [Context7 documentation](https://context7.com/xxyoudeadpunkxx/chatgpt-local-agent-mcp)

## 🤖 AI-assisted development

This project was developed with AI assistance.

The project, code, documentation, and repository materials were shaped through human-directed work supported by AI tools during drafting, implementation, review, testing, and refinement.

AI assistance does not make the project automatically correct, complete, secure, or suitable for every use case. Read it, test it, and adapt it to your own context before exposing local files, shell access, browser sessions, or desktop automation.

---

<details>
<summary><strong>Technical reference</strong> — architecture, tools, configuration, OAuth, development, and troubleshooting</summary>

## Architecture

The server combines:

* a Streamable HTTP MCP transport;
* Express routes for MCP, OAuth, health, and the dashboard;
* GitHub OAuth identity and a separate local OAuth client contract for ChatGPT;
* scope and policy checks before tool execution;
* workspace path guards and secret deny patterns;
* a durable JSONL operation journal;
* file backups for supported destructive tools;
* a Windows installer and local control surfaces;
* optional Cloudflare Tunnel exposure.

Runtime defaults:

```text
Server:     http://127.0.0.1:8789
MCP:        http://127.0.0.1:8789/mcp
Dashboard:  http://127.0.0.1:8789/dashboard
Health:     http://127.0.0.1:8789/healthz
Install:    %LOCALAPPDATA%\chatgpt-local-agent-mcp
```

OAuth metadata:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
```

Dynamic client registration is not exposed.

## Tool registry

The registry currently exposes these tool names.

### Workspace and filesystem

```text
workspace_info
stat
stat_many
list_dir
tree
search
read_file
read_file_range
read_many
hash
write_file
apply_patch
mkdir
copy
move
delete
rollback_backup
```

### Git

```text
git_status
git_diff
git_commit
```

### Shell and process

```text
shell
start_process
stop_process
process_kill
process_list
port_list
tail_log
wait_for_port
```

### Browser

```text
browser_session_create
browser_session_list
browser_session_close
browser_cdp_connect
browser_page_list
browser_page_select
browser_navigate
browser_snapshot
browser_console
browser_network
browser_wait
browser_click
browser_fill
browser_type
browser_press_key
browser_screenshot
```

### Screen and desktop

```text
window_list
screen_screenshot
screen_ocr
desktop_mouse_position
desktop_mouse_move
desktop_mouse_click
desktop_key_press
desktop_hotkey
desktop_text_type
```

The registry assigns each tool:

* one required MCP scope;
* one policy mode;
* a journal policy;
* risk tags shown by the local dashboard.

## Scopes

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

A granted scope does not bypass the maximum policy mode, workspace profile, command policy, confirmation requirement, or path guard.

## Policy modes

From least to most powerful:

```text
observe
  -> diagnose
  -> edit
  -> operate
  -> destructive
```

`GPT_FS_MCP_MAX_POLICY_MODE` sets the server-wide ceiling. A workspace profile can impose a smaller allowed set.

## Command policies

Shell and process execution support:

```text
disabled
workspace_guarded
full
```

`workspace_guarded` checks the working directory, explicit path references, and declared touched paths against workspace and secret-path rules.

For recognized mutative shell commands, `expectedTouchedPaths` is required in guarded mode.

This check is a path-aware guard, not command isolation or an OS sandbox.

## Configuration

Create a private `.env` from `.env.example` in the runtime install folder.

### Local-only smoke test

```env
GPT_FS_MCP_HOST=127.0.0.1
GPT_FS_MCP_PORT=8789
PUBLIC_BASE_URL=http://127.0.0.1:8789
CLOUDFLARE_TUNNEL_ENABLED=false
AUTH_REQUIRED=false
NODE_ENV=development
```

The server refuses `AUTH_REQUIRED=false` when bound beyond loopback, when a public HTTPS URL is configured, when a tunnel is enabled, or when `NODE_ENV` is non-development.

### Authenticated remote connector

```env
GPT_FS_MCP_HOST=127.0.0.1
GPT_FS_MCP_PORT=8789
AUTH_REQUIRED=true
AUTH_REQUIRE_PKCE=true
PUBLIC_BASE_URL=https://your-public-host.example
CLOUDFLARE_TUNNEL_ENABLED=true
CLOUDFLARED_CONFIG=C:\Users\you\.cloudflared\config.yml

GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
ALLOWED_GITHUB_LOGINS=your-github-login

OAUTH_CLIENT_ID=
OAUTH_CLIENT_SECRET=
OAUTH_REDIRECT_URIS=
```

Remote non-loopback URLs must use HTTPS.

### Safer first workspace

When `GPT_FS_MCP_WORKSPACE_PROFILES_JSON` is empty, the server creates profiles for detected filesystem roots. On Windows this normally means available drives such as `C:\` and `D:\`.

`GPT_FS_MCP_DEFAULT_CWD` controls only the starting directory for relative paths. It is **not** an access boundary.

A narrower example:

```env
GPT_FS_MCP_MAX_POLICY_MODE=edit
GPT_FS_MCP_SHELL_POLICY=workspace_guarded
GPT_FS_MCP_PROCESS_POLICY=workspace_guarded
GPT_FS_MCP_WORKSPACE_PROFILES_JSON=[{"name":"test-repo","label":"Disposable test repo","rootPath":"C:\\Users\\you\\Documents\\GitHub\\test-repo","allowedPolicyModes":["observe","diagnose","edit"],"backupPolicy":"snapshot","secretDenyGlobs":["**/.env","**/*secret*","**/*token*","**/*credential*"]}]
```

Increase the policy ceiling or scopes only for a concrete task that requires them.

### Default OAuth scopes

If `DEFAULT_OAUTH_SCOPES` is empty, the server falls back to all known scopes. The supplied `.env.example` also lists all scopes explicitly.

For a first remote test, request only the categories needed for read-only inspection, then add write-capable scopes deliberately.

## OAuth model

There are two separate relationships.

### GitHub OAuth App → server identity

You sign in with GitHub. The server validates the returned login against `ALLOWED_GITHUB_LOGINS` before issuing local MCP authorization.

GitHub callback:

```text
https://your-public-host.example/callback
```

Configuration:

```env
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
ALLOWED_GITHUB_LOGINS=
```

### ChatGPT connector → local MCP server

ChatGPT is the OAuth client for this MCP resource.

Configuration:

```env
OAUTH_CLIENT_ID=
OAUTH_CLIENT_SECRET=
OAUTH_REDIRECT_URIS=
```

The ChatGPT redirect URI is not the GitHub OAuth callback. If the connector is recreated and receives a new redirect URI, update `OAUTH_REDIRECT_URIS`.

## Cloudflare Tunnel

The normal public route is a Tunnel, not a Worker:

```text
https://mcp.your-domain.example -> http://127.0.0.1:8789
```

Minimal `cloudflared` ingress:

```yaml
ingress:
  - hostname: mcp.your-domain.example
    service: http://127.0.0.1:8789
  - service: http_status:404
```

Matching environment values:

```env
PUBLIC_BASE_URL=https://mcp.your-domain.example
CLOUDFLARE_TUNNEL_ENABLED=true
CLOUDFLARED_CONFIG=C:\Users\you\.cloudflared\config.yml
```

A Cloudflare `530` commonly means the local `cloudflared` connector is not running even though the DNS and route exist.

## Journaling and recovery

The server writes an operation journal and marks incomplete operations as `unknown` when recovering after an interrupted run.

Common secret-like keys and shell arguments are redacted from the journal, and sensitive environment variables are removed from spawned command environments. Redaction reduces accidental exposure but cannot guarantee that arbitrary command output contains no secrets.

Supported destructive file tools use dry-run/confirmation patterns and can create file backups when required. `rollback_backup` restores a backup by its returned ID.

Backups are file-level and tool-specific. They are not a universal undo mechanism for shell commands, processes, browser actions, Git commits, or desktop input.

## Browser, screen, and desktop boundaries

Browser automation uses Playwright. Install browser binaries when needed:

```powershell
npx playwright install
```

A newly created Playwright session is different from attaching through CDP to an existing browser. CDP attachment can expose tabs, storage, and logged-in sessions belonging to that profile.

Screen tools can capture visible content. Desktop tools can move the mouse, click, press keys, invoke hotkeys, and type into the active session.

Use a dedicated browser profile and a disposable Windows workspace for initial testing.

## Development

The supported runtime target is Windows.

```powershell
npm ci
npm run type-check
npm test
npm run build
npm start
```

Watch mode:

```powershell
npm run dev
```

The test suite includes command-policy, workspace-default, tool-order, and dashboard loopback checks. Run it on Windows because path-token expectations use Windows path semantics.

## Publish-safe audit

Before sharing the source folder, remove runtime/build artifacts and run:

```powershell
npm run audit:publish-safe
```

The audit rejects items including:

```text
.env
data/
node_modules/
dist/
*.log
```

`.gitignore` helps prevent accidental inclusion, but the audit is the final packaging check.

## Troubleshooting

### Saving `.env` asks for OAuth values during the local smoke test

OAuth values are required while `AUTH_REQUIRED=true`.

For localhost-only testing:

```env
PUBLIC_BASE_URL=http://127.0.0.1:8789
CLOUDFLARE_TUNNEL_ENABLED=false
AUTH_REQUIRED=false
NODE_ENV=development
```

### `/mcp` returns `401`

This is expected for a protected endpoint without a valid bearer token.

### `/authorize` returns `invalid_request`

Check:

* `OAUTH_CLIENT_ID`;
* `OAUTH_REDIRECT_URIS`;
* `PUBLIC_BASE_URL`;
* the requested resource URI;
* PKCE settings.

### `/callback` works but `/token` returns `401`

Check that `OAUTH_CLIENT_SECRET` matches the ChatGPT connector's configured secret.

### GitHub login succeeds but ChatGPT does not connect

Keep these values separate:

```text
GitHub callback:      https://your-public-host.example/callback
ChatGPT connector:   https://your-public-host.example/mcp
ChatGPT redirect:    OAUTH_REDIRECT_URIS
```

### Browser automation fails

Install Playwright browsers and verify the server is running as the Windows account that owns the profile or session you intend to use.

### Public hostname returns Cloudflare `530`

Confirm:

* the MCP server listens on `127.0.0.1:8789`;
* `cloudflared` is running;
* the tunnel has an active replica;
* the route targets `http://127.0.0.1:8789`.

### ChatGPT can read but a write, browser, or desktop action is blocked

Check local scope and policy denials first. If the server allows the action, ChatGPT/OpenAI may still require confirmation or block it at the platform layer.

</details>

---

## License

MIT. See [LICENSE](LICENSE).
