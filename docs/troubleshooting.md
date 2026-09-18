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
