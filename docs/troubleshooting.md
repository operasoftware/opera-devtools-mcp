# Troubleshooting

## General tips

- Run `npx opera-devtools-mcp@latest --help` to test if the MCP server runs on your machine.
- Make sure that your MCP client uses the same npm and node version as your terminal.
- When configuring your MCP client, try using the `--yes` argument to `npx` to
  auto-accept installation prompt.
- Find a specific error in the output of the `opera-devtools-mcp` server.
  Usually, if your client is an IDE, logs would be in the Output pane.

## Debugging

Start the MCP server with debugging enabled and a log file:

- `DEBUG=* npx opera-devtools-mcp@latest --log-file=/path/to/opera-devtools-mcp.log`

Using `.mcp.json` to debug while using a client:

```json
{
  "mcpServers": {
    "opera-devtools": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "opera-devtools-mcp@latest",
        "--log-file",
        "/path/to/opera-devtools-mcp.log"
      ],
      "env": {
        "DEBUG": "*"
      }
    }
  }
}
```

## Specific problems

### `Error [ERR_MODULE_NOT_FOUND]: Cannot find module ...`

This usually indicates either a non-supported Node version is in use or that the
`npm`/`npx` cache is corrupted. Try clearing the cache, uninstalling
`opera-devtools-mcp` and installing it again. Clear the cache by running:

```sh
rm -rf ~/.npm/_npx # NOTE: this might remove other installed npx executables.
npm cache clean --force
```

### `Target closed` error

This indicates that the browser could not be started. Make sure that no Chrome
instances are running or close them. Make sure you have the latest stable Chrome
installed and that [your system is able to run Chrome](https://support.google.com/chrome/a/answer/7100626?hl=en).

### Chrome crashes on macOS when using Web Bluetooth

On macOS, Chrome launched by an MCP client application (such as Claude Desktop) may crash when a Web Bluetooth prompt appears. This is caused by a macOS privacy permission violation (TCC).

To resolve this, grant Bluetooth permission to the MCP client application in `System Settings > Privacy & Security > Bluetooth`. After granting permission, restart the client application and start a new MCP session.

### Remote debugging between virtual machine (VM) and host fails

When attempting to connect to Chrome running on a host machine from within a virtual machine (VM), Chrome may reject the connection due to 'Host' header validation. You can bypass this restriction by creating an SSH tunnel from the VM to the host. In the VM, run:

```sh
ssh -N -L 127.0.0.1:9222:127.0.0.1:9222 <user>@<host-ip>
```

Point the MCP connection inside the VM to `http://127.0.0.1:9222`. This allows DevTools to reach the host browser without triggering the Host validation error.

### Operating system sandboxes

Some MCP clients allow sandboxing the MCP server using macOS Seatbelt or Linux
containers. If sandboxes are enabled, `opera-devtools-mcp` is not able to start
Chrome that requires permissions to create its own sandboxes. As a workaround,
either disable sandboxing for `opera-devtools-mcp` in your MCP client or use
`--browser-url` to connect to a Chrome instance that you start manually outside
of the MCP client sandbox.

### WSL

By default, `opera-devtools-mcp` in WSL requires Chrome to be installed within the Linux environment. While it normally attempts to launch Chrome on the Windows side, this currently fails due to a [known WSL issue](https://github.com/microsoft/WSL/issues/14201). Ensure you are using a [Linux distribution compatible with Chrome](https://support.google.com/chrome/a/answer/7100626).

Possible workarounds include:

- **Install Google Chrome in WSL:**
  - `wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb`
  - `sudo dpkg -i google-chrome-stable_current_amd64.deb`

- **Use Mirrored networking:**
  1. Configure [Mirrored networking for WSL](https://learn.microsoft.com/en-us/windows/wsl/networking).
  2. Start Chrome on the Windows side with:
     `chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\path\to\dir`
  3. Start `opera-devtools-mcp` with:
     `npx opera-devtools-mcp --browser-url http://127.0.0.1:9222`

- **Use PowerShell or Git Bash** instead of WSL.

### Windows 10: Error during discovery for MCP server 'opera-devtools': MCP error -32000: Connection closed

- **Solution 1** Call using `cmd` (For more info https://github.com/modelcontextprotocol/servers/issues/1082#issuecomment-2791786310)

  ```json
  "mcpServers": {
      "opera-devtools": {
        "command": "cmd",
        "args": ["/c", "npx", "-y", "opera-devtools-mcp@latest"]
      }
    }
  ```

  > **The Key Change:** On Windows, running a Node.js package via `npx` often requires the `cmd /c` prefix to be executed correctly from within another process like VSCode's extension host. Therefore, `"command": "npx"` was replaced with `"command": "cmd"`, and the actual `npx` command was moved into the `"args"` array, preceded by `"/c"`. This fix allows Windows to interpret the command correctly and launch the server.

- **Solution 2** Instead of another layer of shell you can write the absolute path to `npx`:
  > Note: The path below is an example. You must adjust it to match the actual location of `npx` on your machine. Depending on your setup, the file extension might be `.cmd`, `.bat`, or `.exe` rather than `.ps1`. Also, ensure you use double backslashes (`\\`) as path delimiters, as required by the JSON format.
  ```json
  "mcpServers": {
      "opera-devtools": {
        "command": "C:\\nvm4w\\nodejs\\npx.ps1",
        "args": ["-y", "opera-devtools-mcp@latest"]
      }
    }
  ```

### Connection timeouts with `--autoConnect`

If you are using the `--autoConnect` flag and tools like `list_pages`, `new_page`, or `navigate_page` fail with a timeout (e.g., `ProtocolError: Network.enable timed out` or `The socket connection was closed unexpectedly`), this usually means the MCP server cannot handshake with the running Chrome instance correctly. Ensure:

1. Chrome 144+ is **already** running.
2. Remote debugging is enabled in Chrome via `chrome://inspect/#remote-debugging`.
3. You have allowed the remote debugging connection prompt in the browser.
4. There is no other MCP server or tool trying to connect to the same debugging port.

> [!IMPORTANT]
> In Chrome versions up to 149, connection issues may be caused by frozen or unloaded tabs.
> Chrome DevTools MCP forces all tabs to be loaded, so ensure your system has sufficient resources.
> It is currently not recommended to use Chrome DevTools MCP with browser instances running hundreds of tabs.
> See [Issue #1921](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1921) for more details.

### A page is selected for me: `the previously selected page was closed`

The browser's tabs are shared with a human, and the browser often outlives its
last window — Opera and Opera Neon keep background services alive, and a browser
process can be briefly still running right after the last tab closes. When a tool
call needs a page and the one it was using is gone, the product replaces the
selection instead of failing, and says so:

```
Note: the browser had no open pages, so a new one was opened. Page 3 is now selected.
```

(The same call reports `Note: the previously selected page was closed. Page N is
now selected.` when it only had to switch to a tab that was still open.)

If the browser had no pages left at all, that page was opened by the call — the
browser is supposed to always have at least one (`close_page` refuses to close the
last one), so an empty browser can only come from outside. Before this, such a call
failed with `The selected page has been closed. Call list_pages to see open pages.`
— an error about a page nobody selected, reported even for commands (like
`opera_list_mcp_servers`) that have nothing to do with pages.

In attached mode (`--browser-url`, `--autoConnect`) the page is a new tab in the
browser you attached to. Nothing else changes: no other tab is closed and no
browser is restarted. The one thing that is _not_ recovered is a page you named
explicitly with `--pageId`: a page id that no longer exists is an error, not
something to redirect.

### `A browser is already running with the profile … so a second one cannot be launched on it`

The profile is held by a browser that is already running, so a second browser
cannot be launched on it. You have two options, and they are not the same thing:

- **Drive the browser that is already running.** It has to have been started with
  a debugging port:

  ```sh
  "/Applications/Opera Neon Developer.app/Contents/MacOS/Opera" \
    --user-data-dir=/tmp/neon-clear-demo --remote-debugging-port=9222
  opera-browser-cli start --browser-url=http://127.0.0.1:9222
  ```

  `--autoConnect` (Chrome 144+) is the variant that reads `DevToolsActivePort`
  from the profile instead of taking a URL. Browser options belong to `start`;
  a tool command such as `list_pages` does not accept them.

- **Use a separate profile** with `--isolated`, which launches its own browser
  and leaves the running one alone.

`--isolated` alone is _not_ a way to attach: it starts a third browser on a
throwaway profile.

### `Could not attach to the browser at …`

An attached browser is not managed by this daemon. Only a browser this daemon
launched itself is restarted for you; if you attached to one and it is gone,
start it again (with remote debugging enabled) and re-attach:

```sh
opera-browser-cli status   # prints which mode the running daemon is in
opera-browser-cli stop     # browser options are fixed when the daemon starts
opera-browser-cli start --browser-url=http://127.0.0.1:9222
```

`status` reports the mode so the recovery to expect is never a guess:

```
browser=launched (owned by this daemon)
browser=attached to http://127.0.0.1:9222
```

A launched browser is relaunched when it dies; an attached one never is, because
killing a browser you are using is not something a tool call should decide.

### An Opera AI command fails, hangs, or leaves several tabs behind

Five browser-side failures look alike from the CLI, and each one has a name
now.

**`Opera AI's own storage rejected the action — the browser reported a missing
file`** (exit 3). The browser answered the dispatch with:

```
Protocol error (Opera.dispatchAction): AbortError NotReadableError Data lost due to missing file. Affected record should be considered irrecoverable
```

That text is Blink's, not this CLI's: IndexedDB raises it when it cannot read a
_large_ value — one whose data lives in a blob file beside the database — because
the file is not there (`indexeddb/idb_request_queue_item.cc`). The profile's copy
of the Neon AI extension then holds a record the browser can no longer read, and
`opera_chat` / `opera_make` fail on it for as long as that profile is used. The
tab still opens and the prompt still goes out — this read is part of starting the
run, not a failure before it — and a read-only call on the same extension is
unaffected, which is why `opera_list_models` keeps working:

```sh
opera-browser-cli opera_list_models      # works: the AI path itself is fine
```

Those files are damaged by killing the browser while its storage utility is
mid-write. A browser that is asked to close flushes its stores; one that is
SIGKILLed does not — and the CLI used to kill the process group on the
`disconnected` event, which Puppeteer also emits during the graceful close the
CLI itself requests (`src/opera/browserCleanup.ts` now arms that kill only for a
browser that goes away without a close). Keep a configured profile out of `/tmp`
for the same reason: the AI's own files and databases live inside it, and `/tmp`
can be cleaned up under it.

A damaged store does not heal, so the profile is spent — use a fresh one, or
delete just the AI extension's databases while the browser is closed, which
keeps its sign-in (that lives in `Default/Local Extension Settings/<id>`, a
different store):

```sh
opera-browser-cli stop
rm -rf <profile>/Default/IndexedDB/chrome-extension_<id>_0.indexeddb.*
```

`<id>` is `cjjfpifpgmmeeeaifjgillmpekjjplhc`, and `<profile>` is the one named by
`--userDataDir` or `OPERA_CLI_USER_DATA_DIR`; only when neither is set is it
`~/.cache/chrome-devtools-mcp-cli/chrome-profile`. A configured profile is a
default: an explicit `--isolated` on the command line wins over it, because the
two are mutually exclusive for the server's argument parser. Report the browser
side with its build, its own error, and the profile it ran on:

```sh
opera-browser-cli logs --errors          # what the browser reported, per attempt
ps -p $(pgrep -f 'MacOS/Opera' | head -1) -o command= | tr ' ' '\n' | grep user-data-dir
```

**`Opera never started the action in the browser`** (exit 3). The dispatch was
sent and the browser reported no progress at all for five minutes — a research
tab that opens with no prompt in it is what this looks like on screen. The
action is treated as one that never started instead of waiting out the twenty
minutes, because a streamed action that has emitted nothing at all is not a slow
one. Once the browser has reported _anything_ the deadline is retired, however
long the run then takes. `opera-browser-cli logs --errors` says what the browser
side reported; storage the browser cannot read is the usual cause (above).

**An AI command that is retried was sent twice.** Opera's AI dispatcher is not
reachable while its service worker is still coming up, and that one failure is
retried — up to five attempts, 2.5 s apart — because it means the action never
reached the AI. Nothing else is: a replay cannot be undone, and `chat`, `do`,
`make` and `research` each open the tab they run in, so a replayed _action_
failure left one tab per attempt (a chat failing on unreadable storage left
five). `logs` shows each replay, which is otherwise invisible in the result:

```sh
opera-browser-cli logs --errors
```

```
Opera dispatch attempt 1/5 failed, retrying in 2500ms: …
```

**`opera_do requires Opera Neon — the connected browser does not support Opera
AI`** (exit 3), or the same sentence naming `opera_chat` and "an Opera browser".
The dispatch never reached Opera's AI at all, which for a browser that has no
Opera AI extension is permanent: it is not Opera, or it is Opera without Neon
for a command only Neon serves (`do`, `make`, `research` — `chat` runs on any
Opera build). The wording is the one the retry above replays while a real
Opera's service worker is still coming up, so this diagnosis is only reached
once those attempts are spent. Point the CLI at the browser you meant:

```sh
opera-browser-cli setup            # writes the executable path to the config
opera-browser-cli stop             # browser options are fixed when the daemon starts
opera-browser-cli doctor           # reports what the AI tools are configured against
```

**`Opera: the Opera AI extension is not available for this profile`** (exit 3).
The dispatch had nowhere to go: the profile the running browser is using does not
carry the Opera AI extension. On an Opera build without Neon that is what `do`,
`make` and `research` hit — they are Neon-only, while `chat` runs on any Opera —
so the remedy names Neon for those and the profile for the rest:

```sh
opera-browser-cli setup            # point at Opera Neon, or at a profile that has the extension
opera-browser-cli doctor           # reports what the AI tools are configured against
```

### `… needs the browser relaunched with Opera's automation flags` (exit 5)

Opera AI refuses to run on a page that reports itself as automation-controlled,
so `opera_do` and `opera_research` need a browser launched with
`--disable-blink-features=AutomationControlled`. A browser this daemon launched
acquires that flag the first time an Opera AI tool needs it — by being relaunched,
which closes whatever pages it had — and keeps it for the rest of its life.
Nothing takes it away again, because taking it away is another relaunch: an
ordinary tool arriving while the flags were on (`take_snapshot` in a second
terminal) used to close the browser and kill whatever else was running in it,
including a streaming `do`.

The acquisition is the only relaunch left, so it is the only one that can still
disturb a session, and it waits for the browser to fall idle first. If something
is still inside a tool invocation after ten seconds — a `navigate_page`, a chat
that is streaming, another `opera_do` — it refuses rather than close that work:

```
opera_do needs the browser relaunched with Opera's automation flags, and it is in use by take_snapshot — relaunching it now would close that work. Timed out waiting for the browser to be free; retry when it is.
```

Retry when the named tool has finished. Concurrent Opera AI runs are unaffected
(the first `do` already gave the browser its flags), and the browser keeps them
until it is restarted — so an ordinary DevTools tool that runs after an Opera AI
command is running against a browser whose page reports `navigator.webdriver`
as false, until `opera-browser-cli stop` (or a crash) replaces it.

### Chunks arrive while an Opera AI command runs

The Opera AI commands (`opera_chat`, `opera_do`, `opera_make`, `opera_research`)
write their partial output to stderr as it arrives; the final result goes to
stdout. Two timeouts sit in front of them — the CLI's wait on the daemon's
socket, and the daemon's wait on the MCP server around the tool call — and the
shorter one decides for everyone. The daemon used to hold every call to the MCP
SDK's own 60-second default, so a research run was killed there with
`MCP error -32001: Request timed out` while the CLI was still waiting out its
twenty minutes, and since a timed-out request is cancelled the run was aborted
in the browser too. Both ends now ask the same question (`operaAiTimeoutMs`), so
the twenty minutes are a ceiling on the whole call, not a deadline on each chunk.

A redirection keeps exactly the chunks:

```sh
opera-browser-cli opera_do "check today's headlines" 2>chunks.log
```

Each streaming request carries its own token, so two commands running at once —
a second terminal, or a second command while the first is still going — each
keep their own chunks and neither one's ending stops the other's. A command that
does not ask for chunks gets none.
