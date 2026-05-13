# Changelog

## [0.2.2](https://github.com/operasoftware/opera-devtools-mcp/compare/opera-devtools-mcp-v0.2.0...opera-devtools-mcp-v0.2.2) (2026-05-28)

### Upstream intake

Rebased onto [chrome-devtools-mcp 1.1.1](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/CHANGELOG.md) (from 0.26.0). See upstream changelog for the full list of upstream changes.

## [0.2.0](https://github.com/operasoftware/opera-devtools-mcp/compare/opera-devtools-mcp-v0.1.1...opera-devtools-mcp-v0.2.0) (2026-05-13)

### Upstream intake

Rebased onto [chrome-devtools-mcp 0.26.0](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/CHANGELOG.md) (from 0.21.0). See upstream changelog for the full list of upstream changes.

## [0.1.1](https://github.com/operasoftware/opera-devtools-mcp/compare/opera-devtools-mcp-v0.1.0...opera-devtools-mcp-v0.1.1) (2026-04-14)

### 🎉 Features

* Add Opera Neon tools: `dispatchAction` and `dispatchWithStreamedResponse`
* Add automation flag for Opera Neon DO and Research tools
* Run Opera tools in parallel by skipping the global tool mutex

### 🛠️ Fixes

* Clean up CDP listeners on MCP cancellation

## [0.1.0](https://github.com/operasoftware/opera-devtools-mcp/releases/tag/opera-devtools-mcp-v0.1.0) (2026-04-14)

### Initial release

Fork of [chrome-devtools-mcp 0.21.0](https://github.com/ChromeDevTools/chrome-devtools-mcp) with Opera-specific customizations:

* Rename package to `opera-devtools-mcp`, update branding throughout
* Remove Google telemetry (ClearcutLogger upload stripped)
* Satisfy Apache 2.0 license requirements (NOTICE file, license headers)
