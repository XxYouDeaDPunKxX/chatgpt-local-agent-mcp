# Local Agent MCP test coverage

The project registers **53 MCP tools**. The automated suite now checks that every handler rejects a schema-valid call without its required scope (`tool-authorization.test.ts`). **That security check is not functional coverage.**

The categories below describe the additional evidence for each tool:

- **Fixture:** Handler behavior exercised with synthetic data, an isolated MCP client, a disposable workspace, a local HTTP page, or a child process. A fixture test covers only its named scenario, not every branch. Some Windows operations skip when the OS denies the required process API.
- **Manual read/dry-run:** Opt-in Windows test (`npm run test:desktop`) observes state or checks a non-executing preview. It does not send desktop input.
- **Conditional fixture:** A real handler is called with synthetic input, but a successful result depends on an optional local executable.

| Tool | Evidence | Test |
| --- | --- | --- |
| `workspace_info` | Fixture | `filesystem-handlers` |
| `stat` | Fixture | `filesystem-handlers` |
| `list_dir` | Fixture | `filesystem-handlers` |
| `tree` | Fixture | `filesystem-handlers` |
| `search` | Fixture | `filesystem-handlers` |
| `read_file` | Fixture | `filesystem-handlers` |
| `read_many` | Fixture | `filesystem-handlers` |
| `read_file_range` | Fixture | `filesystem-handlers` |
| `stat_many` | Fixture | `filesystem-handlers` |
| `hash` | Fixture | `filesystem-handlers` |
| `write_file` | Fixture | `filesystem-handlers` |
| `apply_patch` | Fixture | `filesystem-handlers` |
| `mkdir` | Fixture | `filesystem-handlers` |
| `copy` | Fixture | `filesystem-handlers` |
| `move` | Fixture | `filesystem-handlers` |
| `delete` | Fixture | `filesystem-handlers` |
| `rollback_backup` | Fixture | `filesystem-handlers` |
| `git_status` | Fixture | `git-process-handlers` |
| `git_diff` | Fixture | `git-process-handlers` |
| `git_commit` | Fixture | `git-process-handlers` |
| `start_process` | Fixture, short-lived process | `git-process-handlers` |
| `tail_log` | Fixture | `git-process-handlers`, `tail-log-metadata` |
| `wait_for_port` | Fixture | `git-process-handlers` |
| `process_list` | Fixture, read-only inspection when WMI permits enumeration | `git-process-handlers` |
| `port_list` | Fixture, loopback listener | `git-process-handlers` |
| `stop_process` | Fixture: already-exited case and live, self-terminating synthetic child; live termination skips on Windows access denial | `git-process-handlers` |
| `process_kill` | Fixture: validates child identity, previews and kills only its own synthetic child when WMI permits it; otherwise skips | `git-process-handlers` |
| `browser_session_create` | Fixture, isolated Chromium | `browser-handlers` |
| `browser_navigate` | Fixture | `browser-handlers` |
| `browser_snapshot` | Fixture | `browser-handlers` |
| `browser_console` | Fixture | `browser-handlers` |
| `browser_network` | Fixture | `browser-handlers` |
| `browser_wait` | Fixture | `browser-handlers` |
| `browser_click` | Fixture: DOM effect checked; CDP popup ownership checked separately | `browser-handlers`, `cdp-multitab` |
| `browser_fill` | Fixture, immediate DOM effect checked after fill | `browser-handlers` |
| `browser_type` | Fixture, resulting text checked | `browser-handlers` |
| `browser_press_key` | Fixture, key submission only | `browser-handlers` |
| `browser_screenshot` | Fixture, PNG/hash checked | `browser-handlers` |
| `browser_page_list` | Fixture | `browser-handlers` |
| `browser_page_select` | Fixture | `browser-handlers` |
| `browser_session_list` | Fixture | `browser-handlers` |
| `browser_session_close` | Fixture | `browser-handlers` |
| `browser_cdp_connect` | Fixture: temporary Chromium CDP, pre-existing unrelated tab preserved through rejected selection and agent click, agent-created out-of-scope popup closed; confirmation guard | `cdp-multitab`, `browser-handlers` |
| `window_list` | Manual read/dry-run | `manual/desktop-dryrun` |
| `screen_screenshot` | Opt-in physical 2x2 region fixture; excluded from default headless suite | `app-runtime-e2e` |
| `screen_ocr` | Conditional fixture: synthetic text PNG, recognition when Tesseract is present or explicit unavailable response otherwise | `screen-ocr` |
| `desktop_mouse_position` | Manual read/dry-run | `manual/desktop-dryrun` |
| `desktop_mouse_move` | Manual read/dry-run | `manual/desktop-dryrun` |
| `desktop_mouse_click` | Manual read/dry-run | `manual/desktop-dryrun` |
| `desktop_key_press` | Manual read/dry-run | `manual/desktop-dryrun` |
| `desktop_hotkey` | Manual read/dry-run | `manual/desktop-dryrun` |
| `desktop_text_type` | Manual read/dry-run | `manual/desktop-dryrun` |
| `shell` | Fixture, bounded synthetic command | `git-process-handlers` |

**Coverage accounting:** 45 tools have positive-path fixture scenarios in code (including the opt-in physical `screen_screenshot` case), 7 have separate manual read/dry-run evidence, and `screen_ocr` has a conditional recognition fixture. Every one of the 53 has an automated missing-scope test. The default headless run does not prove physical screen capture, Tesseract recognition, or process termination where Windows denies access. These counts are tool-level categories, not line or branch coverage percentages.

## How to run

From the project root on Windows:

```powershell
npm ci
npx playwright install chromium
npm run type-check
npm run build
npm test
npm run test:desktop  # optional; requires an interactive Windows session
$env:LOCAL_AGENT_TEST_DESKTOP_CAPTURE='1'; npm test  # optional physical capture in an interactive desktop
```

The GitHub Actions workflow runs the main suite on Windows. The 2x2 physical desktop capture is opt-in and is always skipped in CI. The opt-in desktop suite is not part of CI. Process tests that require WMI or `taskkill` skip when Windows explicitly denies access. All default test output is synthetic or reduced to assertions; desktop tests do not print window titles or type/click anything.

## Remaining acceptance gaps

- **CDP multi-tab ownership (P18):** isolated regression now verifies that an unrelated tab already present at CDP attach survives both rejected page selection and an agent click, while a popup opened by that click is closed when outside the allowlist. A later acceptance check against the actual installed integration remains useful; the user's active Chrome profile is excluded from automation.
- **Browser postconditions (P05/P14):** the fixture verifies the resulting DOM through a later snapshot, but the current `browser_click`/`browser_fill` response itself does not attest the postcondition.
- **Managed process termination:** the live `stop_process` regression uses a child that exits automatically if termination is denied. In the current restricted Windows environment, `taskkill` returned `Accesso negato`, so the live stop path remains unverified there. The same applies to `process_kill` and process enumeration through WMI.
- **OCR:** a synthetic text PNG now exercises `screen_ocr`; recognition is asserted when Tesseract is available. Without Tesseract, only the structured unavailable response is verified.
- **End-to-end production:** real OAuth with GitHub, Cloudflare tunnel, ChatGPT connectivity, and interactive desktop effects require a dedicated acceptance environment.

Do not infer complete tool behavior coverage from the number of passing tests. Treat newly added tools as uncovered until a meaningful fixture and a corresponding entry here are added.
