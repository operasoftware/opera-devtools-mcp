# Browser session recovery: a closed page, and who owns the browser

Status: implemented. Companion to `stress-test-system-plan.md` (the harness this
behaviour is verified with) and `STRESS_TEST_ROBUSTNESS_PLAN.md` (the daemon
supervision it builds on).

## The problem this answers

A user closed the browser's window while the CLI was between commands. The next
command failed with:

```
Error: The selected page has been closed. Call list_pages to see open pages.
```

Three things were wrong with that outcome, and they are worth separating because
only the first was about pages:

1. **The selection was never repaired.** `McpContext.getSelectedMcpPage()` throws
   when the selected page is closed, and tool invocation resolved the page with
   that strict accessor. The self-healing write already existed — but only on the
   snapshot path: `createPagesSnapshot()` re-selects the first live page and
   records `#selectedPageFallback`, which the response renders as _"the previously
   selected page was closed. Page N is now selected."_ `list_pages` therefore
   recovered; a tool call did not.
2. **An empty browser had no defined behaviour.** The product already forbids
   leaving zero pages through its own tools — `close_page` refuses the last page
   (`CLOSE_PAGE_ERROR = 'The last open page cannot be closed. It is fine to keep
it open.'`) — so a browser with no pages can only come from outside. Nothing
   defined what a tool call should then do.
3. **The message described the wrong subject.** Every Opera AI/MCP tool is a
   `definePageTool` because it needs a `CDPSession` handle (`page._client()`) to
   send Opera's `dispatchAction` domain — not because it acts on a page. A command
   like `opera_list_mcp_servers` therefore reported a page error for an operation
   that has nothing to do with pages.

## What the product does now

**Resolution is recovering, not strict, on the tool path only.** `ToolHandler`
resolves a page-scoped tool's page with `resolveSelectedPage()` from
`src/opera/pageRecovery.ts`:

1. the strict accessor, unchanged, on the happy path — no listing, no CDP round
   trip;
2. if it throws, `createPagesSnapshot()` — a live page, if one exists, becomes the
   selection and the existing note explains the swap;
3. if the browser has no pages at all, **one page is opened** (`about:blank`, the
   default of `browser.newPage()`), selected, and reported through the same note:

   ```
   Note: the browser had no open pages, so a new one was opened. Page 3 is now selected.
   ```

   The reporting is the fork's own rather than upstream's selection-fallback note,
   because that note cannot survive this path: `McpResponse.handle` clears it by
   taking its own page snapshot before reading it (`McpResponse.ts:461-462`, then
   `:944`), so a replacement made _before_ the tool runs — which is every case
   here — is never reported by it. A page that appears in the user's browser
   (attached mode) must not be silent, so `resolveSelectedPage` writes the line
   through the response it is given, and both sub-cases get one:

   | Recovery                                  | Note                                                                                    |
   | ----------------------------------------- | --------------------------------------------------------------------------------------- |
   | a live page replaced the closed selection | `Note: the previously selected page was closed. Page N is now selected.`                |
   | no page existed, so one was opened        | `Note: the browser had no open pages, so a new one was opened. Page N is now selected.` |

Two properties were chosen deliberately:

- **Single-flight.** Opera tools bypass the tool mutex (`bypassMutex`), so two of
  them can resolve a page at the same moment; they share one in-flight recovery
  promise rather than opening a page each.
- **Only when a tool needs a page.** `list_pages`, `new_page` and `close_page` are
  not page-scoped and create nothing, so `list_pages` keeps telling the truth (an
  empty browser lists no pages) and the page appears on the first call that
  actually needs one.

**A page the caller named is never recovered.** With page-id routing enabled, an
explicit `pageId` goes to `context.getPageById(pageId)` exactly as before: a page
that no longer exists is the caller's error to see, and a recovery page there
would silently redirect the call to another tab.

**`getSelectedMcpPage()` keeps its contract.** It still throws — upstream's
`tests/McpContext.test.ts` and `tests/tools/pages.test.ts` pin that — because a
caller that must not act on a different page than it asked for still needs it.

## Ownership is visible now

Attaching (`--browser-url`, `--ws-endpoint`, `--autoConnect`) and launching are
both supported and stay supported; what changed is that the product says which one
you are in, and scopes its promises accordingly:

|                                   | launched (we spawned it)                                                                                                                           | attached (your browser)                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser process died              | the next call relaunches it                                                                                                                        | an error naming the target: _"An attached browser is not managed by this daemon, so it is not restarted for you — start it again and re-attach."_ |
| Selected page closed, others live | re-select + note                                                                                                                                   | re-select + note; nothing in your browser is touched                                                                                              |
| No pages at all                   | one page opened + note                                                                                                                             | one page opened + note (a new tab in your browser)                                                                                                |
| Opera automation flags needed     | acquired once, then kept for the browser's life; the acquisition waits for an idle browser and refuses (exit 5) rather than close work in progress | never relaunched                                                                                                                                  |

`opera-browser-cli status` reports the mode, derived from the daemon's stored argv
through the same predicate the server applies (`isLaunchMode`,
`describeBrowserMode` in `src/opera/browserFlags.ts` — one source of truth, no new
channel between the processes). The stored argv is the one the user typed, so the
read-back normalizes it before matching: `--browser-url` and `--browserUrl`,
`--flag value` and `--flag=value`, and `--no-flag` / `--flag=false` all decide
the way the parsed flags do:

```
browser=launched (owned by this daemon)
browser=attached to http://127.0.0.1:9222
```

The profile-in-use failure now names both real remedies instead of suggesting
`--isolated` for a case where `--isolated` is the wrong answer (it starts a _third_
browser rather than attaching to the one you have). All three lifecycle messages
live in `src/opera/browserErrors.ts`, so `src/browser.ts` keeps call sites.

**The Opera automation flags are sticky.** Opera AI refuses to run when the page
reports itself as automation-controlled, so `opera_do` and `opera_research` need
a browser launched with `--disable-blink-features=AutomationControlled`. That flag
is acquired by relaunching a browser this daemon launched, and then kept for the
rest of that browser's life. It used to be enforced in both directions, and the
direction that took it away — an ordinary tool arriving while the browser carried
it — closed the browser: two `opera_do` runs streaming in one browser died with
the AI dispatcher's `The dispatcher was not able to dispatch: no target` the
moment a third terminal asked for `take_snapshot`, and a running `navigate_page`
was closed the moment another terminal started a `do`.

So the flags are a property of the browser rather than of the tool that happens
to be running. A browser that has them keeps them until it is gone, and the next
browser this server launches starts without them — they are still not applied to
every launch, because the flag changes observable page behaviour for ordinary
DevTools tools. The one relaunch that remains is the acquisition, and it waits
for every other invocation to finish first (`src/opera/browserActivity.ts` counts
them); if the browser is still in use after ten seconds it refuses with exit 5
and names the tools holding it, because the relaunch would close their pages.
The flags are matched against the browser instance that holds them, so a browser
that died and was relaunched — without them — is acquired again by the next
`opera_do` rather than assumed to have them.

## Decisions, and what was rejected

| Decision                  | Chosen                                                                             | Rejected alternative, and why                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Behaviour with zero pages | act — open one page                                                                | an error with better wording; product intent is to act, and the page is what the product's own tooling already guarantees                                                                                                                                                                                                          |
| Where it applies          | both modes                                                                         | launch mode only: an attached browser is _more_ likely to lose tabs (a human is clicking) and re-selecting is internal state                                                                                                                                                                                                       |
| Where to recover          | the failure path only                                                              | a health check on every call: an extra `Target.getTargets` per tool invocation for a state that is rare                                                                                                                                                                                                                            |
| Where the logic lives     | an Opera module driving `McpContext`'s **public** API                              | a method on `McpContext`: it needed private state for the note and cost ~50 lines of upstream drift; `createPagesSnapshot()`/`newPage()` record that note themselves, so the fork needs nothing private                                                                                                                            |
| Reporting the recovery    | the fork writes the note through the response                                      | relying on upstream's selection-fallback note: `McpResponse.handle` clears it with its own snapshot before reading it, so it never covers a replacement made earlier in the call — and a page opened in someone's browser must not be silent                                                                                       |
| Bundle-level Opera tools  | stay page-scoped                                                                   | giving them a browser-target CDP session would be semantically cleaner, but whether Opera answers `Opera.dispatchAction` on a browser session is unverified and the recovery removes the practical problem                                                                                                                         |
| Ownership model           | keep attach, make the mode explicit                                                | blocking attach in the CLI would delete a deliberate, tested feature (`OPERA_CLI_BROWSER_URL` promotion) and the documented routes for sandboxed, remote and signed-in-Neon use                                                                                                                                                    |
| Opera flag changes        | acquire once, keep for the browser's life, gate the acquisition on an idle browser | a conditional downgrade (skip it only while a browser is busy): keeps the flags a per-tool invariant, but the swap still closes the browser as soon as it is idle — losing the tabs the user is reading — and the policy stays two-directional, which is what turned a snapshot in one terminal into a browser teardown in another |

### Why not inheritance

Subclassing `McpContext` was the first idea and it does not work here: its
constructor is private (`src/McpContext.ts:127`) and it is created by the static
factory `McpContext.from()`, which returns a base-class instance after running a
private `#init()`. A subclass would need upstream to open the constructor and make
`from()` generic — _more_ upstream drift than the method it replaces — and
`ToolHandler`/`McpResponse` are typed to the concrete class, so every call site
would have to be re-typed as well. Composition through a `Proxy` was the other
candidate; it survives only if every forwarded method is bound to the real
instance (private `#fields` reject a foreign receiver), which is clever in a way
that hides the failure mode. Driving the public API from a fork module is the
boring version that keeps the seam at one call site.

## Files

Opera-owned: `src/opera/pageRecovery.ts` (the resolution, single-flight),
`src/opera/browserErrors.ts` (the lifecycle prose), `src/opera/browserFlags.ts`
(the mode predicate, exported), `src/opera/browserActivity.ts` (who is inside a
tool invocation right now — what a relaunch waits for) and
`src/opera/toolHandlerHooks.ts` (the claims taken and released around every
invocation).

Upstream files, carried as fork divergence (`docs/UPSTREAM.md`):
`src/ToolHandler.ts` (two hook calls, plus its header comment),
`src/bin/chrome-devtools.ts` (`browser=…` in `status`),
`src/browser.ts` (three message call sites). **`src/McpContext.ts` and
`src/McpResponse.ts` are untouched by this change** — that is the point of the
split.

## Verification

- `tests/opera/browserFlags.test.ts` — the flag policy against stubbed launch
  seams: the acquisition, the stickiness (a tool that needs no flags never
  touches the browser — the regression that closed a browser under a streaming
  `do`), a second acquisition for a browser relaunched without the flags, and the
  two ends of the idle gate: a relaunch that waits for the other invocation to
  finish, and the refusal that names it. **Needs no browser**, so it runs
  anywhere.
- `tests/ToolHandler.test.ts` — the claims: an invocation that fails still hands
  its browser claim back, observed from another claim.
- `tests/opera/pageRecovery.test.ts` — the resolution itself, against a stubbed
  context: the happy path costs no listing, a live page is re-selected without
  opening anything, an empty browser gets exactly one page and says so, concurrent
  resolutions share it, and a recovery entry does not outlive itself. **Needs no
  browser**, so it runs anywhere.
- `tests/ToolHandler.test.ts` — the integration point: a page-scoped tool whose
  selection was closed runs against the re-selected page; a browser with no pages
  gets one; an explicitly named page is not recovered.
- `tests/stress/H1` (`browser-crash.test.ts`) — the end-to-end contract in the
  container: a session is driven to zero pages from outside (a script-opened page
  replaces the first one, which is closed by id, and the replacement closes
  itself, with `--keep-alive-for-test` keeping the process alive), and the next
  page-scoped call must succeed, report the opened page
  (`the browser had no open pages, so a new one was opened`), keep the same browser
  pid, and leave exactly one page behind — also on a repeat call, which must not
  report a second recovery or add a second page.

## Open items, deliberately not done here

- **`G4`**: tool commands reject browser options with a bare `Unknown arguments`;
  only `start` accepts them. The message should say so.
- **`G2`**: attaching automatically when a launch fails because the profile is held
  _and_ a `DevToolsActivePort` exists. Rejected for now: a silent mode switch
  should be opted into.
