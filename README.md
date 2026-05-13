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

| Tool             | Description                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `opera_chat`     | Send a chat prompt to Opera's built-in AI and return the response.                                      |
| `opera_do`       | Instruct Opera's built-in AI to perform an action on the current page.                                  |
| `opera_make`     | Ask Opera's built-in AI to create or generate content.                                                  |
| `opera_research` | Ask Opera's built-in AI to research a topic. Supports `local`, `one-minute`, and `deep` research modes. |

## Disclaimers

`opera-devtools-mcp` exposes content of the browser instance to the MCP clients
allowing them to inspect, debug, and modify any data in the browser or DevTools.
Avoid sharing sensitive or personal information that you don't want to share with
MCP clients.

Performance tools may send trace URLs to the Google CrUX API to fetch real-user
experience data. To disable this, run with the `--no-performance-crux` flag.

## Requirements

- [Node.js](https://nodejs.org/) [LTS](https://github.com/nodejs/Release#release-schedule) version.
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
      "args": [
        "-y",
        "opera-devtools-mcp@latest",
        "--browser-url=http://127.0.0.1:9222"
      ]
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

- **Input automation** (10 tools)
  - [`click`](docs/tool-reference.md#click)
  - [`drag`](docs/tool-reference.md#drag)
  - [`fill`](docs/tool-reference.md#fill)
  - [`fill_form`](docs/tool-reference.md#fill_form)
  - [`handle_dialog`](docs/tool-reference.md#handle_dialog)
  - [`hover`](docs/tool-reference.md#hover)
  - [`press_key`](docs/tool-reference.md#press_key)
  - [`type_text`](docs/tool-reference.md#type_text)
  - [`upload_file`](docs/tool-reference.md#upload_file)
  - [`click_at`](docs/tool-reference.md#click_at)
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
- **Performance** (3 tools)
  - [`performance_analyze_insight`](docs/tool-reference.md#performance_analyze_insight)
  - [`performance_start_trace`](docs/tool-reference.md#performance_start_trace)
  - [`performance_stop_trace`](docs/tool-reference.md#performance_stop_trace)
- **Network** (2 tools)
  - [`get_network_request`](docs/tool-reference.md#get_network_request)
  - [`list_network_requests`](docs/tool-reference.md#list_network_requests)
- **Debugging** (8 tools)
  - [`evaluate_script`](docs/tool-reference.md#evaluate_script)
  - [`get_console_message`](docs/tool-reference.md#get_console_message)
  - [`lighthouse_audit`](docs/tool-reference.md#lighthouse_audit)
  - [`list_console_messages`](docs/tool-reference.md#list_console_messages)
  - [`take_screenshot`](docs/tool-reference.md#take_screenshot)
  - [`take_snapshot`](docs/tool-reference.md#take_snapshot)
  - [`screencast_start`](docs/tool-reference.md#screencast_start)
  - [`screencast_stop`](docs/tool-reference.md#screencast_stop)
- **Memory** (5 tools)
  - [`take_heapsnapshot`](docs/tool-reference.md#take_heapsnapshot)
  - [`get_heapsnapshot_class_nodes`](docs/tool-reference.md#get_heapsnapshot_class_nodes)
  - [`get_heapsnapshot_details`](docs/tool-reference.md#get_heapsnapshot_details)
  - [`get_heapsnapshot_retainers`](docs/tool-reference.md#get_heapsnapshot_retainers)
  - [`get_heapsnapshot_summary`](docs/tool-reference.md#get_heapsnapshot_summary)
- **Opera** (4 tools)
  - [`opera_chat`](docs/tool-reference.md#opera_chat)
  - [`opera_do`](docs/tool-reference.md#opera_do)
  - [`opera_make`](docs/tool-reference.md#opera_make)
  - [`opera_research`](docs/tool-reference.md#opera_research)
- **Extensions** (5 tools)
  - [`install_extension`](docs/tool-reference.md#install_extension)
  - [`list_extensions`](docs/tool-reference.md#list_extensions)
  - [`reload_extension`](docs/tool-reference.md#reload_extension)
  - [`trigger_extension_action`](docs/tool-reference.md#trigger_extension_action)
  - [`uninstall_extension`](docs/tool-reference.md#uninstall_extension)
- **Third-party** (2 tools)
  - [`execute_3p_developer_tool`](docs/tool-reference.md#execute_3p_developer_tool)
  - [`list_3p_developer_tools`](docs/tool-reference.md#list_3p_developer_tools)
- **WebMCP** (2 tools)
  - [`execute_webmcp_tool`](docs/tool-reference.md#execute_webmcp_tool)
  - [`list_webmcp_tools`](docs/tool-reference.md#list_webmcp_tools)

<!-- END AUTO GENERATED TOOLS -->

## Configuration

The Opera DevTools MCP server supports the following configuration options:

<!-- BEGIN AUTO GENERATED OPTIONS -->

- **`--autoConnect`/ `--auto-connect`**
  If specified, automatically connects to a browser (Chrome 144+) running locally from the user data directory identified by the channel param (default channel is stable). Requires the remote debugging server to be started in the Chrome instance via chrome://inspect/#remote-debugging.
  - **Type:** boolean
  - **Default:** `false`

- **`--browserUrl`/ `--browser-url`, `-u`**
  Connect to a running, debuggable Chrome instance (e.g. `http://127.0.0.1:9222`). For more details see: https://github.com/operasoftware/opera-devtools-mcp#connecting-to-a-running-chrome-instance.
  - **Type:** string

- **`--wsEndpoint`/ `--ws-endpoint`, `-w`**
  WebSocket endpoint to connect to a running Chrome instance (e.g., ws://127.0.0.1:9222/devtools/browser/<id>). Alternative to --browserUrl.
  - **Type:** string

- **`--wsHeaders`/ `--ws-headers`**
  Custom headers for WebSocket connection in JSON format (e.g., '{"Authorization":"Bearer token"}'). Only works with --wsEndpoint.
  - **Type:** string

- **`--headless`**
  Whether to run in headless (no UI) mode.
  - **Type:** boolean
  - **Default:** `false`

- **`--executablePath`/ `--executable-path`, `-e`**
  Path to custom Chrome executable.
  - **Type:** string

- **`--isolated`**
  If specified, creates a temporary user-data-dir that is automatically cleaned up after the browser is closed. Defaults to false.
  - **Type:** boolean

- **`--userDataDir`/ `--user-data-dir`**
  Path to the user data directory for Chrome. Default is $HOME/.cache/opera-devtools-mcp/chrome-profile$CHANNEL_SUFFIX_IF_NON_STABLE
  - **Type:** string

- **`--channel`**
  Specify a different Chrome channel that should be used. The default is the stable channel version.
  - **Type:** string
  - **Choices:** `canary`, `dev`, `beta`, `stable`

- **`--logFile`/ `--log-file`**
  Path to a file to write debug logs to. Set the env variable `DEBUG` to `*` to enable verbose logs. Useful for submitting bug reports.
  - **Type:** string

- **`--viewport`**
  Initial viewport size for the Chrome instances started by the server. For example, `1280x720`. In headless mode, max size is 3840x2160px.
  - **Type:** string

- **`--proxyServer`/ `--proxy-server`**
  Proxy server configuration for Chrome passed as --proxy-server when launching the browser. See https://www.chromium.org/developers/design-documents/network-settings/ for details.
  - **Type:** string

- **`--acceptInsecureCerts`/ `--accept-insecure-certs`**
  If enabled, ignores errors relative to self-signed and expired certificates. Use with caution.
  - **Type:** boolean

- **`--experimentalPageIdRouting`/ `--experimental-page-id-routing`**
  Whether to expose pageId on page-scoped tools and route requests by page ID (useful for concurrent agent sessions).
  - **Type:** boolean

- **`--experimentalDevtools`/ `--experimental-devtools`**
  Whether to enable automation over DevTools targets
  - **Type:** boolean

- **`--experimentalVision`/ `--experimental-vision`**
  Whether to enable coordinate-based tools such as click_at(x,y). Usually requires a computer-use model able to produce accurate coordinates by looking at screenshots.
  - **Type:** boolean

- **`--experimentalMemory`/ `--experimental-memory`**
  Whether to enable experimental memory tools.
  - **Type:** boolean

- **`--experimentalStructuredContent`/ `--experimental-structured-content`**
  Whether to output structured formatted content.
  - **Type:** boolean

- **`--experimentalIncludeAllPages`/ `--experimental-include-all-pages`**
  Whether to include all kinds of pages such as webviews or background pages as pages.
  - **Type:** boolean

- **`--experimentalScreencast`/ `--experimental-screencast`**
  Exposes experimental screencast tools (requires ffmpeg). Install ffmpeg https://www.ffmpeg.org/download.html and ensure it is available in the MCP server PATH.
  - **Type:** boolean

- **`--experimentalFfmpegPath`/ `--experimental-ffmpeg-path`**
  Path to ffmpeg executable for screencast recording.
  - **Type:** string

- **`--categoryExperimentalWebmcp`/ `--category-experimental-webmcp`**
  Set to true to enable debugging WebMCP tools. Requires Chrome 149+ with the following flags: `--enable-features=WebMCPTesting,DevToolsWebMCPSupport`
  - **Type:** boolean

- **`--chromeArg`/ `--chrome-arg`**
  Additional arguments for Chrome. Only applies when Chrome is launched by opera-devtools-mcp.
  - **Type:** array

- **`--ignoreDefaultChromeArg`/ `--ignore-default-chrome-arg`**
  Explicitly disable default arguments for Chrome. Only applies when Chrome is launched by opera-devtools-mcp.
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

- **`--categoryExtensions`/ `--category-extensions`**
  Set to true to include tools related to extensions. Note: This feature is currently only supported with a pipe connection. autoConnect, browserUrl, and wsEndpoint are not supported with this feature until 149 will be released.
  - **Type:** boolean
  - **Default:** `false`

- **`--categoryExperimentalThirdParty`/ `--category-experimental-third-party`**
  Set to true to enable third-party developer tools exposed by the inspected page itself
  - **Type:** boolean
  - **Default:** `false`

- **`--performanceCrux`/ `--performance-crux`**
  Set to true to enable sending URLs from performance traces to CrUX API to get field performance data.
  - **Type:** boolean
  - **Default:** `false`

- **`--usageStatistics`/ `--usage-statistics`**
  Set to true to opt-in to usage statistics collection. Google collects usage data to improve the tool, handled under the Google Privacy Policy (https://policies.google.com/privacy). This is independent from Chrome browser metrics. Disabled if `OPERA_DEVTOOLS_NO_USAGE_STATISTICS` or `CI` env variables are set.
  - **Type:** boolean
  - **Default:** `false`

- **`--slim`**
  Exposes a "slim" set of 3 tools covering navigation, script execution and screenshots only. Useful for basic browser tasks.
  - **Type:** boolean

- **`--redactNetworkHeaders`/ `--redact-network-headers`**
  If true, redacts some of the network headers considered sensitive before returning to the client.
  - **Type:** boolean
  - **Default:** `false`

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

### Concurrent sessions

Most MCP clients start one Chrome DevTools MCP server per conversation. If your
client shares a single server instance across concurrent agents or subagents,
start the server with `--experimentalPageIdRouting`. This exposes `pageId` on
page-scoped tools so each agent can route tool calls to the tab it is working
with.

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest",
        "--experimentalPageIdRouting"
      ]
    }
  }
}
```

If you run multiple independent MCP client sessions and want each session to
launch its own temporary Chrome profile, also pass `--isolated`. This avoids
sharing the default Chrome DevTools MCP user data directory between those
server instances.

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
