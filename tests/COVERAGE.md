# Local Agent MCP test coverage

The project registers **53 MCP tools**. The automated suite now checks that every handler rejects a schema-valid call without its required scope (`tool-authorization.test.ts`). **That security check is not functional coverage.**

The categories below describe the additional evidence for each tool:

- **Fixture:** Handler behavior exercised with synthetic data, an isolated MCP client, a disposable workspace, a local HTTP page, or a child process. A fixture test covers only its named scenario, not every branch.
- **Manual read/dry-run:** Opt-in Windows test (`npm run test:desktop`) observes state or checks a non-executing preview. It does not send desktop input.
- **Guard only:** A refusal or the universal missing-scope check is covered, but the tool's positive operational path is not.

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
| `process_list` | Fixture, read-only inspection | `git-process-handlers` |
| `port_list` | Fixture, loopback listener | `git-process-handlers` |
| `stop_process` | Fixture, already-exited process only | `git-process-handlers` |
| `process_kill` | Fixture: validates child identity, previews and kills only its own synthetic child | `git-process-handlers` |
| `browser_session_create` | Fixture, isolated Chromium | `browser-handlers` |
| `browser_navigate` | Fixture | `browser-handlers` |
| `browser_snapshot` | Fixture | `browser-handlers` |
| `browser_console` | Fixture | `browser-handlers` |
| `browser_network` | Fixture | `browser-handlers` |
| `browser_wait` | Fixture | `browser-handlers` |
| `browser_click` | Fixture, DOM effect checked | `browser-handlers` |
| `browser_fill` | Fixture, resulting text checked | `browser-handlers` |
| `browser_type` | Fixture, resulting text checked | `browser-handlers` |
| `browser_press_key` | Fixture, key submission only | `browser-handlers` |
| `browser_screenshot` | Fixture, PNG/hash checked | `browser-handlers` |
| `browser_page_list` | Fixture | `browser-handlers` |
| `browser_page_select` | Fixture | `browser-handlers` |
| `browser_session_list` | Fixture | `browser-handlers` |
| `browser_session_close` | Fixture | `browser-handlers` |
| `browser_cdp_connect` | Guard only: confirmation required | `browser-handlers` |
| `window_list` | Manual read/dry-run | `manual/desktop-dryrun` |
| `screen_screenshot` | Fixture, 2x2 region | `app-runtime-e2e` |
| `screen_ocr` | Scope check only | `tool-authorization` |
| `desktop_mouse_position` | Manual read/dry-run | `manual/desktop-dryrun` |
| `desktop_mouse_move` | Manual read/dry-run | `manual/desktop-dryrun` |
| `desktop_mouse_click` | Manual read/dry-run | `manual/desktop-dryrun` |
| `desktop_key_press` | Manual read/dry-run | `manual/desktop-dryrun` |
| `desktop_hotkey` | Manual read/dry-run | `manual/desktop-dryrun` |
| `desktop_text_type` | Manual read/dry-run | `manual/desktop-dryrun` |
| `shell` | Fixture, bounded synthetic command | `git-process-handlers` |

**Coverage accounting:** 44 tools have some automated positive-path fixture evidence, 7 have separate manual read/dry-run evidence, and 2 have guard-only evidence. Every one of the 53 has an automated missing-scope test. These counts are tool-level categories, not line or branch coverage percentages.

## How to run

From the project root on Windows:

```powershell
npm ci
npx playwright install chromium
npm run type-check
npm run build
npm test
npm run test:desktop  # optional; requires an interactive Windows session
```

The GitHub Actions workflow runs the main suite on Windows. It skips only the 2x2 physical desktop capture when `CI` is set. The opt-in desktop suite is not part of CI. All test output is synthetic or reduced to assertions; desktop tests do not print window titles or type/click anything.

## Remaining acceptance gaps

- **CDP multi-tab ownership (P18):** no isolated regression test proving that unrelated tabs remain untouched. Attaching to the user's active Chrome profile is intentionally excluded from automation.
- **Browser postconditions (P05/P14):** the fixture verifies the resulting DOM through a later snapshot, but the current `browser_click`/`browser_fill` response itself does not attest the postcondition.
- **Managed process termination:** `stop_process` is exercised on a process that already exited; its active-process path still needs an isolated regression test. `process_kill` is exercised only on a child created by the test.
- **OCR:** no reliable synthetic text recognition fixture, and local Tesseract availability is not guaranteed.
- **End-to-end production:** real OAuth with GitHub, Cloudflare tunnel, ChatGPT connectivity, and interactive desktop effects require a dedicated acceptance environment.

Do not infer complete tool behavior coverage from the number of passing tests. Treat newly added tools as uncovered until a meaningful fixture and a corresponding entry here are added.
