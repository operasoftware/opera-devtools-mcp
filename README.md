# Opera DevTools MCP

This is a fork of [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) (Copyright 2025 Google LLC), extended with Opera Neon AI features.

[![npm opera-devtools-mcp package](https://img.shields.io/npm/v/opera-devtools-mcp.svg)](https://npmjs.org/package/opera-devtools-mcp)

`opera-devtools-mcp` lets your coding agent (such as Claude, Cursor, or Copilot)
control and inspect a live browser. It acts as a Model-Context-Protocol
(MCP) server, giving your AI coding assistant access to the full power of
DevTools for reliable automation, in-depth debugging, and performance analysis.
When connected to Opera Neon, it also exposes Opera's built-in AI capabilities.

## [Tool reference](./docs/tool-reference.md) | [Changelog](./CHANGELOG.md) | [Contributing](./CONTRIBUTING.md) | [Troubleshooting](./docs/troubleshooting.md) | [Design Principles](./docs/design-principles.md)

## Key features

- **Opera Neon AI tools**: Interact with Opera's built-in AI directly from your
  coding agent — chat, perform page actions, generate content, and run research.
- **Get performance insights**: Uses [Chrome
  DevTools](https://github.com/ChromeDevTools/devtools-frontend) to record
  traces and extract actionable performance insights.
- **Advanced browser debugging**: Analyze network requests, take screenshots and
  check browser console messages (with source-mapped stack traces).
- **Reliable automation**: Uses
  [puppeteer](https://github.com/puppeteer/puppeteer) to automate actions in
  the browser and automatically wait for action results.

## Opera Neon AI tools

These tools are only available when connected to Opera Neon via `--browser-url`.

| Tool | Description |
|------|-------------|
| `opera_chat` | Send a chat prompt to Opera's built-in AI and return the response. |
| `opera_do` | Instruct Opera's built-in AI to perform an action on the current page. |
| `opera_make` | Ask Opera's built-in AI to create or generate content. |
| `opera_research` | Ask Opera's built-in AI to research a topic. Supports `local`, `one-minute`, and `deep` research modes. |

## Disclaimers

`opera-devtools-mcp` exposes content of the browser instance to the MCP clients
allowing them to inspect, debug, and modify any data in the browser or DevTools.
Avoid sharing sensitive or personal information that you don't want to share with
MCP clients.

Performance tools may send trace URLs to the Google CrUX API to fetch real-user
experience data. To disable this, run with the `--no-performance-crux` flag.

## Requirements

- [Node.js](https://nodejs.org/) v20.19 or a newer [latest maintenance LTS](https://github.com/nodejs/Release#release-schedule) version.
- A Chromium-based browser (Chrome or Opera Neon).
- [npm](https://www.npmjs.com/)

## Getting started

Add the following config to your MCP client:

```json
{
  "mcpServers": {
    "opera-devtools": {
      "command": "npx",
      "args": ["-y", "opera-devtools-mcp@latest"]
    }
  }
}
```

> [!NOTE]
> Using `opera-devtools-mcp@latest` ensures that your MCP client will always use the latest version of the Opera DevTools MCP server.

### Connecting to Opera Neon

To use Opera Neon AI tools, start Opera Neon with remote debugging enabled and connect via `--browser-url`:

```json
{
  "mcpServers": {
    "opera-devtools": {
      "command": "npx",
      "args": ["-y", "opera-devtools-mcp@latest", "--browser-url=http://127.0.0.1:9222"]
    }
  }
}
```

Start Opera Neon with the remote debugging port:

```bash
# macOS
/Applications/Opera\ Neon.app/Contents/MacOS/Opera\ Neon --remote-debugging-port=9222 --user-data-dir=/tmp/opera-profile
```

### MCP Client configuration

<details>
  <summary>Claude Code</summary>

```bash
claude mcp add opera-devtools --scope user npx opera-devtools-mcp@latest
```

</details>

<details>
  <summary>Cursor</summary>

Go to `Cursor Settings` -> `MCP` -> `New MCP Server`. Use the config provided above.

</details>

<details>
  <summary>Copilot / VS Code</summary>

Follow the VS Code [MCP configuration guide](https://code.visualstudio.com/docs/copilot/chat/mcp-servers#_add-an-mcp-server) using the standard config from above, or use the CLI:

```bash
code --add-mcp '{"name":"opera-devtools","command":"npx","args":["-y","opera-devtools-mcp"],"env":{}}'
```

</details>

<details>
  <summary>Windsurf</summary>
  Follow the <a href="https://docs.windsurf.com/windsurf/cascade/mcp#mcp-config-json">configure MCP guide</a>
  using the standard config from above.
</details>

<details>
  <summary>Cline</summary>
  Follow https://docs.cline.bot/mcp/configuring-mcp-servers and use the config provided above.
</details>

### Your first prompt

Enter the following prompt in your MCP Client to check if everything is working:

```
Check the performance of https://opera.com
```

Your MCP client should open the browser and record a performance trace.

> [!NOTE]
> The MCP server will start the browser automatically once the MCP client uses a tool that requires a running browser instance. Connecting to the Opera DevTools MCP server on its own will not automatically start the browser.

## Tools

If you run into any issues, checkout our [troubleshooting guide](./docs/troubleshooting.md).

<!-- BEGIN AUTO GENERATED TOOLS -->

- **Opera Neon AI** (4 tools, Opera Neon only)
  - `opera_chat`
  - `opera_do`
  - `opera_make`
  - `opera_research`
- **Input automation** (9 tools)
  - [`click`](docs/tool-reference.md#click)
  - [`drag`](docs/tool-reference.md#drag)
  - [`fill`](docs/tool-reference.md#fill)
  - [`fill_form`](docs/tool-reference.md#fill_form)
  - [`handle_dialog`](docs/tool-reference.md#handle_dialog)
  - [`hover`](docs/tool-reference.md#hover)
  - [`press_key`](docs/tool-reference.md#press_key)
  - [`type_text`](docs/tool-reference.md#type_text)
  - [`upload_file`](docs/tool-reference.md#upload_file)
- **Navigation automation** (6 tools)
  - [`close_page`](docs/tool-reference.md#close_page)
  - [`list_pages`](docs/tool-reference.md#list_pages)
  - [`navigate_page`](docs/tool-reference.md#navigate_page)
  - [`new_page`](docs/tool-reference.md#new_page)
  - [`select_page`](docs/tool-reference.md#select_page)
  - [`wait_for`](docs/tool-reference.md#wait_for)
- **Emulation** (2 tools)
  - [`emulate`](docs/tool-reference.md#emulate)
  - [`resize_page`](docs/tool-reference.md#resize_page)
- **Performance** (4 tools)
  - [`performance_analyze_insight`](docs/tool-reference.md#performance_analyze_insight)
  - [`performance_start_trace`](docs/tool-reference.md#performance_start_trace)
  - [`performance_stop_trace`](docs/tool-reference.md#performance_stop_trace)
  - [`take_memory_snapshot`](docs/tool-reference.md#take_memory_snapshot)
- **Network** (2 tools)
  - [`get_network_request`](docs/tool-reference.md#get_network_request)
  - [`list_network_requests`](docs/tool-reference.md#list_network_requests)
- **Debugging** (6 tools)
  - [`evaluate_script`](docs/tool-reference.md#evaluate_script)
  - [`get_console_message`](docs/tool-reference.md#get_console_message)
  - [`lighthouse_audit`](docs/tool-reference.md#lighthouse_audit)
  - [`list_console_messages`](docs/tool-reference.md#list_console_messages)
  - [`take_screenshot`](docs/tool-reference.md#take_screenshot)
  - [`take_snapshot`](docs/tool-reference.md#take_snapshot)

<!-- END AUTO GENERATED TOOLS -->

## Configuration

The Opera DevTools MCP server supports the following configuration options:

<!-- BEGIN AUTO GENERATED OPTIONS -->

- **`--autoConnect`/ `--auto-connect`**
  If specified, automatically connects to a browser running locally from the user data directory identified by the channel param (default channel is stable).
  - **Type:** boolean
  - **Default:** `false`

- **`--browserUrl`/ `--browser-url`, `-u`**
  Connect to a running, debuggable browser instance (e.g. `http://127.0.0.1:9222`).
  - **Type:** string

- **`--wsEndpoint`/ `--ws-endpoint`, `-w`**
  WebSocket endpoint to connect to a running browser instance (e.g., ws://127.0.0.1:9222/devtools/browser/<id>). Alternative to --browserUrl.
  - **Type:** string

- **`--wsHeaders`/ `--ws-headers`**
  Custom headers for WebSocket connection in JSON format (e.g., '{"Authorization":"Bearer token"}'). Only works with --wsEndpoint.
  - **Type:** string

- **`--headless`**
  Whether to run in headless (no UI) mode.
  - **Type:** boolean
  - **Default:** `false`

- **`--executablePath`/ `--executable-path`, `-e`**
  Path to custom browser executable.
  - **Type:** string

- **`--isolated`**
  If specified, creates a temporary user-data-dir that is automatically cleaned up after the browser is closed.
  - **Type:** boolean

- **`--userDataDir`/ `--user-data-dir`**
  Path to the user data directory for the browser.
  - **Type:** string

- **`--channel`**
  Specify a different Chrome channel that should be used.
  - **Type:** string
  - **Choices:** `stable`, `canary`, `beta`, `dev`

- **`--logFile`/ `--log-file`**
  Path to a file to write debug logs to.
  - **Type:** string

- **`--viewport`**
  Initial viewport size. For example, `1280x720`.
  - **Type:** string

- **`--proxyServer`/ `--proxy-server`**
  Proxy server configuration passed as --proxy-server when launching the browser.
  - **Type:** string

- **`--acceptInsecureCerts`/ `--accept-insecure-certs`**
  If enabled, ignores errors relative to self-signed and expired certificates. Use with caution.
  - **Type:** boolean

- **`--experimentalVision`/ `--experimental-vision`**
  Whether to enable coordinate-based tools such as click_at(x,y).
  - **Type:** boolean

- **`--experimentalScreencast`/ `--experimental-screencast`**
  Exposes experimental screencast tools (requires ffmpeg).
  - **Type:** boolean

- **`--chromeArg`/ `--chrome-arg`**
  Additional arguments for the browser. Only applies when the browser is launched by opera-devtools-mcp.
  - **Type:** array

- **`--ignoreDefaultChromeArg`/ `--ignore-default-chrome-arg`**
  Explicitly disable default arguments for the browser.
  - **Type:** array

- **`--categoryEmulation`/ `--category-emulation`**
  Set to false to exclude tools related to emulation.
  - **Type:** boolean
  - **Default:** `true`

- **`--categoryPerformance`/ `--category-performance`**
  Set to false to exclude tools related to performance.
  - **Type:** boolean
  - **Default:** `true`

- **`--categoryNetwork`/ `--category-network`**
  Set to false to exclude tools related to network.
  - **Type:** boolean
  - **Default:** `true`

- **`--performanceCrux`/ `--performance-crux`**
  Set to false to disable sending URLs from performance traces to CrUX API to get field performance data.
  - **Type:** boolean
  - **Default:** `true`

- **`--slim`**
  Exposes a "slim" set of 3 tools covering navigation, script execution and screenshots only.
  - **Type:** boolean

<!-- END AUTO GENERATED OPTIONS -->

Pass them via the `args` property in the JSON configuration. For example:

```json
{
  "mcpServers": {
    "opera-devtools": {
      "command": "npx",
      "args": [
        "opera-devtools-mcp@latest",
        "--headless=true",
        "--isolated=true"
      ]
    }
  }
}
```

### Connecting via WebSocket with custom headers

```json
{
  "mcpServers": {
    "opera-devtools": {
      "command": "npx",
      "args": [
        "opera-devtools-mcp@latest",
        "--wsEndpoint=ws://127.0.0.1:9222/devtools/browser/<id>",
        "--wsHeaders={\"Authorization\":\"Bearer YOUR_TOKEN\"}"
      ]
    }
  }
}
```

## Concepts

### User data directory

`opera-devtools-mcp` starts a browser instance using the following user data directory:

- Linux / macOS: `$HOME/.cache/chrome-devtools-mcp/chrome-profile-$CHANNEL`
- Windows: `%HOMEPATH%/.cache/chrome-devtools-mcp/chrome-profile-$CHANNEL`

The user data directory is not cleared between runs. Set the `isolated` option to `true`
to use a temporary user data dir instead which will be cleared automatically after
the browser is closed.

### Connecting to a running browser instance

By default, the server will start a new Chrome instance with a dedicated profile. You can instead connect to a running instance via `--browser-url`:

```json
{
  "mcpServers": {
    "opera-devtools": {
      "command": "npx",
      "args": [
        "opera-devtools-mcp@latest",
        "--browser-url=http://127.0.0.1:9222"
      ]
    }
  }
}
```

Start the browser with the remote debugging port enabled:

**macOS (Chrome)**

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-profile-stable
```

**macOS (Opera Neon)**

```bash
/Applications/Opera\ Neon.app/Contents/MacOS/Opera\ Neon --remote-debugging-port=9222 --user-data-dir=/tmp/opera-profile
```

**Linux**

```bash
/usr/bin/google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-profile-stable
```

**Windows**

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%TEMP%\chrome-profile-stable"
```

> [!WARNING]
> Enabling the remote debugging port opens up a debugging port on the running browser instance. Any application on your machine can connect to this port and control the browser. Make sure that you are not browsing any sensitive websites while the debugging port is open.

### Debugging Chrome on Android

Please consult [these instructions](./docs/debugging-android.md).

## Known limitations

See [Troubleshooting](./docs/troubleshooting.md).

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
