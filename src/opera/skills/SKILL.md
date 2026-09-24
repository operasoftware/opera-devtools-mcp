---
name: opera-browser-cli
description: Browser automation and web interaction using the opera-browser-cli tool. Use for navigating pages, clicking elements, filling forms, taking screenshots, inspecting console/network, running performance audits, and Opera AI features (chat available on any Opera browser; invoke_do, opera_make, opera_research require Opera Neon).
metadata: {'openclaw': {'requires': {'bins': ['opera-browser-cli']}}}
---

# Skill: opera-browser-cli Browser Automation

`opera-browser-cli` drives an Opera browser session through the
`opera-devtools-mcp` daemon. Every command is an MCP tool name.

- **Page and DevTools commands** (`new_page`, `take_snapshot`, `click`, `fill`,
  `take_screenshot`, `list_pages`, `list_console_messages`,
  `list_network_requests`, `lighthouse_audit`, the `*_heapsnapshot_*` family,
  `emulate`, `screencast_start`, …) work with any Opera browser.
- **`opera_chat`** — available on any Opera browser. Pass `--model <id>` to
  select a model and `--conversation_id <id>` to continue a conversation. List
  models with `opera_list_models`.
- **`opera_do`, `opera_make`, `opera_research`** — require **Opera Neon** with an
  active sign-in. `opera_make` accepts `--conversation_id <id>` to continue an
  existing conversation.
- **Opera AI MCP passthrough** (`opera_list_mcp_servers`, `opera_list_mcp_tools`,
  `opera_call_mcp_tool`, `opera_register_mcp_server`, `opera_authenticate_mcp_server`,
  `opera_unregister_mcp_server`, `opera_enable_mcp_server`,
  `opera_disable_mcp_server`, `opera_connect_mcp_server`) — require Opera Neon.
- **Research conversations are not resumable**: each research run creates a fresh
  conversation with no `--conversation_id` flag. The ID it prints can be used
  with `opera_chat` or `opera_make` for follow-ups in the same context.

Run `opera-browser-cli --help` for the full command list, or
`opera-browser-cli <command> --help` for one command's positionals and flags.

```bash
opera-browser-cli new_page https://example.com   # start here
```

## Calling convention

Required parameters are **positional**; optional ones are `--flags`. Tool
parameter names are snake_case, exactly as the MCP tool declares them.

```bash
opera-browser-cli click 1_4 --dblClick true   # NOT: click --uid 1_4
```

Run `opera-browser-cli <command> --help` to see the exact shape.

Element refs are accepted in either form — `@2.4` as the snapshot prints it, or
the wire form `2_4` — on `click`, `fill`, `hover`, `drag`, `upload_file`,
`take_screenshot --uid`, and `url`.

## Snapshot format

Snapshots are **compact** by default: internal role names are shortened, refs use
the `@PAGE.ELEM` form (e.g. `@2.4`), headings become markdown, and redundant ARIA
attributes are stripped. Every command that returns a snapshot also prints
contextual `help[N]:` suggestions for the next step.

Pass `--raw` on any command to get the unprocessed MCP output instead, or
`--full` to keep the complete snapshot without truncation.

Repeated or very long URLs in compact output are replaced with `$uN` tokens, and
a `urls:` trailer lists what each token resolves to. Both the body and the
trailer keep the shortened (origin-stripped) form; `url` prints the full URL:

```
  @2.4 link "Download" url=$u1
  ...
urls:
  $u1 /downloads/installer-v3.2.1-x86_64.tar.gz
```

```bash
opera-browser-cli url $u1     # answered from the last snapshot's token map — no round-trip
opera-browser-cli url @2.4    # a ref is page state, so this takes a fresh snapshot
```

## Long-running Opera AI commands stream

`opera_chat`, `opera_do`, `opera_make`, `opera_research`,
`opera_call_mcp_tool`, and `opera_authenticate_mcp_server` write their partial
output to **stderr** as it arrives; the final result goes to stdout.

A dropped connection mid-call is **not** retried for these six. They are
long-running, may be billable, and may already have acted on the page, so a
silent second run could double a booking as easily as it could double a bill.
Ask the user before re-running one.

## Exit codes

Branch on the exit code rather than parsing messages:

| Code | Meaning                                             | What to do                                         |
| ---- | --------------------------------------------------- | -------------------------------------------------- |
| 0    | Success                                             | —                                                  |
| 2    | Bad arguments, or the browser cannot do this        | Fix the command; do not retry as-is                |
| 3    | Environment not ready (daemon, browser, connection) | Run `opera-browser-cli doctor`                     |
| 4    | Sign-in, subscription, or consent needed            | Ask the user — you cannot fix this                 |
| 5    | Timed out                                           | Retry                                              |
| 6    | Stale element ref, or a closed page                 | Re-run `take_snapshot`, then retry with fresh refs |
| 1    | Anything else                                       | Report it                                          |

## Configuration

```bash
opera-browser-cli setup                    # interactive; writes ~/.opera-browser-cli/config
opera-browser-cli setup --non-interactive  # detect and write, no prompts
opera-browser-cli doctor                   # inspect config, browser, daemon, log
opera-browser-cli doctor --fix             # repair what needs no decision
opera-browser-cli logs                     # tail the daemon log
opera-browser-cli logs --errors --follow   # just the failures, streaming
```

Settings live in `~/.opera-browser-cli/config` as `KEY="VALUE"` lines, and are
also readable from the environment (the environment wins):

| Key                         | Meaning                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `OPERA_CLI_EXECUTABLE_PATH` | Opera binary to launch                                               |
| `OPERA_CLI_USER_DATA_DIR`   | Persistent profile directory (an explicit `--isolated` wins over it) |
| `OPERA_CLI_HEADED`          | `1` to run headed (visible)                                          |
| `OPERA_CLI_CHROME_ARGS`     | Whitespace-separated Chromium flags                                  |
| `OPERA_CLI_BROWSER_URL`     | Attach to an already-running browser instead of launching            |

The config file is a cache of decisions, never a prerequisite: the first command
on a fresh machine detects the installed browser and configures itself.

## Recovery is automatic

The daemon starts on demand and restarts itself on version skew, a crash, or a
dropped connection. Do not run `stop` speculatively — re-run the command. `stop`
exists for cleanup at the end of a session.

## Sign-in errors

If an Opera AI command exits `4`, tell the user to sign in to their Opera account
in a visible window. `opera-browser-cli doctor` reports the configuration that
the AI tools depend on.
