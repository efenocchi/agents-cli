## Unreleased

- **Remote plan previews are isolated by source path (RUSH-1631).** Cache key is `host/sha1(path)/basename` so two worktrees sharing a plan basename no longer clobber each other. Source: `apps/factory/src/vscode/settings.vscode.ts`.
- **Windows remote dispatch uses distinct PowerShell stdout/stderr log paths (RUSH-1622).** `Start-Process -RedirectStandardOutput` and `-RedirectStandardError` cannot share a file; use `.out.log` / `.err.log`. Source: `apps/factory/src/vscode/settings.vscode.ts`.

# Changelog

All notable changes to the Factory extension are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); `scripts/release.sh` requires a
`## [<version>]` section for the version being published.

## [Unreleased]

- **Factory Floor surfaces agent-created tickets as clickable Linear artifacts (RUSH-1547).**
  Session cards and detail panes now render linked Linear badges for carried/created
  ticket refs and include commit chips in the produced-artifacts row, so PRs,
  tickets, teams, plans, and commits are visible without reading the transcript.
  Source: `ui/settings/components/mission-control/FeedItem.tsx`,
  `UnifiedAgentsPane.tsx`.
- **Factory tmux tabs close when their top-level pane exits (RUSH-1543).**
  Tmux-backed agent tabs now install a guarded pane-death hook: exiting a user
  split still closes only that split, but when the last remaining pane dies,
  Factory detaches, kills the tmux session, and lets the VS Code
  terminal close instead of lingering on a "Pane is dead" banner. Source:
  `src/vscode/tmux.ts`.
- **Per-session rate-limit badge on feed cards (RUSH-1523).** Sessions whose transcript shows a rate/usage limit render a distinct **rate limited** pill so they no longer look like healthy running agents. Source: `floorModel.ts` (`rateLimited`), `floorAdapter.ts` (`detectSessionRateLimited`), `FeedItem.tsx`.
- **Feed cards get an Open/Resume-in-terminal action (RUSH-1520).** Each card shows a Terminal button that focuses an open tab, attaches a tmux rail, or runs `agents sessions focus <id>` — so the operator jumps into the session instead of only opening the side panel. Source: `ui/settings/components/mission-control/FeedItem.tsx`, `UnifiedAgentsPane.tsx` (`openTerminalForAgent`).
- **Filter + group-by controls live in the feed header bar next to Save view (RUSH-1526).** The feed's own header (`SavedViews` / `feed-header-bar`) now carries Group + status chips (Needs you / Running / Idle / Failed) + agent-abbr chips, so operators filter and group where they are looking — not only from the top FloorControls bar. Source: `ui/settings/components/mission-control/SavedViewsBar.tsx`, `UnifiedAgentsPane.tsx`, `floor.css`.
- **Floor Group defaults to Outcome (ticket/PR/worktree) instead of Project (RUSH-1479).** Fleet-scale floors collapse agents under the deliverable they serve so the operator sees initiatives, not ~1,100 processes. Source: `ui/settings/components/mission-control/floorModel.ts` (`outcomeLabel`, `FloorGroupBy`), `FloorControls.tsx`, `UnifiedAgentsPane.tsx`.
- **The extension's parallel session stack is gone — live-session state now comes from the CLI (#741).**
  Activity, waiting-for-input, awaiting reason, and tokens/sec ride the
  `agents sessions --active --json` payload (`ActiveSession.activity` /
  `awaitingReason` / `tokPerSec`) instead of being re-derived from per-agent
  transcript-tail parsers; the Recent Sessions picker is backed by
  `agents sessions --json` (fixing the stale `~/.gemini/sessions` scan — the CLI
  scans the real `~/.gemini/tmp`); the machine-wide session watcher configures
  its roots from `agents sessions --roots --json`; and the agent registry
  (`BUILT_IN_AGENTS` launch commands, `.agents` config agent ids) derives from a
  CLI-registry snapshot validated against `apps/cli` source in tests — which
  also fixes antigravity launching a nonexistent `antigravity` binary instead of
  `agy`, and `.agents` files silently dropping newer agents (grok, droid, …).
  Source: `apps/factory/src/core/{session.activity,remoteSessions,agents,agents.cli,swarmifyConfig}.ts`,
  `apps/factory/src/vscode/{remoteSessions,terminals,watchdog,settings,sessions}.vscode.ts`,
  `apps/factory/src/monitor/{sessionParse,sessionWatcher}.ts`.
- **Internal: `foreman.vscode.ts` reuses the shared `humanElapsed` helper (#753).** Deleted the identical private `humanElapsedFromMs` copy and imported the exported `humanElapsed` from `core/foreman.digest.ts`. No behavior change. Source: `apps/factory/src/vscode/foreman.vscode.ts`.
- **Windows device dispatch no longer hardcodes `bash -lc`.** `dispatchToDevice` selects the remote shell from the device registry platform (PowerShell `-EncodedCommand` on windows; bash on POSIX), so Dispatch v2 works on win-mini. Source: `apps/factory/src/core/deviceDispatchShell.ts`, `apps/factory/src/vscode/settings.vscode.ts`. (RUSH-1481)

### Fixed

- **Factory watchdog logs now use the canonical cache path documented by AGENTS.** The
  watchdog bridge, watchdog tick writer, and Factory Floor log reader share one
  `WATCHDOG_LOG_PATH` at `~/.agents/.cache/logs/watchdog.log`, matching the
  post-restructure docs and CLI migration target. (RUSH-1516)
- **Factory Floor cards now use human session names instead of UUID slices (RUSH-1532).**
  Remote sessions preserve explicit labels separately from task topics, and the Floor
  card header prefers label, topic, branch, ticket, and worktree metadata before falling
  back to a generic agent title. Cloud single-agent rows now use their configured name
  or prompt line instead of `agent-019e30a2`-style identifiers.
- **NEEDS YOU precision — finished/stopped agents no longer masquerade as needing
  input (RUSH-1522).** Two gates tightened. (1) `derivePhase` now checks terminal
  statuses first: a `completed`/`stopped`/`failed` agent can no longer be lifted
  into the `waiting` phase by a stale `waitingForInput` flag — it lands in
  DONE/idle/FAILED where it belongs. (2) The prose trailing-"?" waiting heuristic
  now decays: past 30 minutes with no session writes (`PROSE_QUESTION_FRESH_MS`),
  a session that signed off with "anything else?" stops classifying as waiting —
  previously such sessions sat in NEEDS YOU indefinitely (the reported card was 13
  days stale). Structural signals are exempt: a genuinely pending
  `AskUserQuestion`/`ExitPlanMode` still lands in NEEDS YOU at any age. Source:
  `ui/settings/components/mission-control/floorModel.ts` (`derivePhase`),
  `src/core/session.activity.ts` (`detectWaitingForInput`),
  `src/core/remoteSessions.ts` (`enrichWithSessionContent`),
  `src/vscode/terminals.vscode.ts`.

### Added

- **Factory Floor cards now surface plan artifacts for preview (RUSH-1525).**
  Session output, recent worktree files, and attachment refs are scanned for
  `.html` and `ref-*.md` plan files; matching cards show plan chips that open HTML
  plans externally and Markdown plans in the editor preview.
- **Project rollups — one glance answers "what's happening in this project".** The
  rail's Projects flyout rows now carry dim sub-counts (open backlog tickets and
  distinct open PRs) next to the live agent count, and each card in the Projects
  pane gains an activity line — "3 running · 1 waiting · 4 backlog · 2 PRs ·
  active 40m ago" (or "quiet") — all derived in one pass from the live feed and
  backlog the Floor already holds.
- **PR board — every open PR the floor's agents produced, in one actionable list.**
  A new PRs center tab aggregates the live feed's PR URLs and shows, per PR: CI
  state, review decision (approved / changes requested / review required), merge
  conflicts, a chip for the agent that owns it (jumps to its card), and a **Merge**
  button that appears only when the PR is open, not draft, approved, CI-green, and
  conflict-free. Rows are ranked for action: ready-to-merge first, then red CI /
  conflicts, then changes-requested. Merge runs plain `gh pr merge --rebase` (never
  `--admin` — branch protection stays in force); refusals surface inline on the row.
- **Recap — a work ledger for "what happened while I was away".** A new Recap center
  (clock button on the rail, Recap tab in the strip) lists finished sessions across the
  whole fleet, grouped by day, each with its task line, project · host · branch, ticket,
  a PR link, and the session's real duration and cost. Day headers roll up sessions,
  spend, and PRs (e.g. "Today — 12 sessions · $18.40 · 3 PRs"). No new bookkeeping: the
  CLI's `agents sessions` metrics (`durationMs`, `costUsd`, `tokenCount`) were already
  computed per session and are now carried through instead of dropped. Live sessions are
  excluded — the feed owns what's running, the ledger owns what finished.
- **The backlog now shows who is already working each ticket.** A ticket an agent
  carries gets an in-flight chip on its row (phase dot + agent abbr, `+N` when several
  are on it; hover for the full roster), and the ticket detail pane gains an **In
  flight** section — one row per worker with phase, host, and PR, each jumping to that
  agent's card. Dispatching onto a ticket that's already in flight is guarded: the
  button turns amber, reads "Dispatch anyway", and names the agent already on it, so a
  second agent is a deliberate choice instead of an accident.

### Changed

- **Plan-watch now reads from the CLI's canonical `session.plan` field instead of re-parsing
  raw JSONL.** `watchForPlan` previously read the session `.jsonl` file and re-implemented the
  `ExitPlanMode` scanner (`parsePlanFromClaudeJsonl`) — a duplicate of the CLI's session state
  engine. The CLI now carries `plan` on `SessionMeta` (surfaced via `agents sessions <id>
  --json`), so the extension polls the CLI directly and `parsePlanFromClaudeJsonl` is deleted.
  No behavior change for the Floor's plan-ready surface. (RUSH-1505)

- **The collapsed Floor rail's Projects and Hosts buttons are now flyout menus instead of
  three buttons that all expanded the sidebar.** Click Projects for the curated project
  list (live agent count + amber waiting count per project, plus any uncurated project
  that has agents running) and jump straight to that scope; click Hosts for the fleet
  roster with health dots and per-host counts. The Hosts button carries a red dot whenever
  any host is offline, a lime **Dispatch** button now sits at the top of the rail, and the
  `»` chevron is the single expand affordance. Active states are fixed across the board
  (Backlog lights when the backlog center is showing; a project/host scope lights its
  button), and the rail-vs-sidebar choice is remembered across reloads.

### Fixed

- **"Needs you" in the rail and sidebar now actually filters the feed.** It used to clear
  all filters — identical to "All agents" — despite the amber badge. It now toggles the
  same `needs` status chip the controls bar drives, and "All agents" clears it.

## [0.9.291] - 2026-07-09

### Fixed

- **NEEDS-YOU cards no longer show a doubled, contextless "Thinking…".** A paused/idle
  card rendered the live-activity fallback string `"Thinking..."` twice — once as the card
  body and again as the green now-line — because `resp` fell back to the live-activity
  string when the agent had no last message. `resp` is now strictly the agent's last real
  message (empty when there is none), and the now-line renders only while an agent is
  actively working (`running`/`stalled`), so a paused card that's waiting on you shows just
  its task, progress timeline, and reply box.

### Added

- **The NEEDS-YOU detail panel now shows why an agent is blocked, the task, and the real
  question with one-click answers.** A blocked card used to surface only a status word and
  a "Thinking…" line — you had to open the terminal to find out what it wanted. The
  decision block at the top of the right pane now renders a **why-blocked chip** (Question
  / Plan review / Permission — permission in red), the **original task** for context, and
  the **real question with its option chips**, sourced from the CLI's structured decision
  (`sessions --json` `question`) rather than a regex over prose. Extracted into
  `<AgentDecision>` so the preview harness renders the exact markup (`?view=decision`).
  (RUSH-1521, RUSH-1546)
- **Inline approve/deny for interactive prompts.** When an option maps to a select-list
  keystroke — a permission prompt (Approve=`1` / Deny=`esc`), a plan review, or an
  `AskUserQuestion` — clicking it now sends that **keystroke** through the existing
  terminal/tmux reply rail (the proven Ink text-then-CR and `tmux send-keys` paths)
  instead of a label the TUI would ignore, so you can unblock without opening the
  terminal. Cloud/team replies stay label-based (semantic-message APIs). (RUSH-453)

### Fixed

- **Cloud status + latest-activity now render identically across hosts.** The Electron app
  and the VS Code extension carried two divergent `mapCloudStatus` tables — the extension
  missed `error` / `in_progress` / `queued` and matched case-sensitively, the app missed
  `allocating` / `needs_review` — so the same cloud run could show a different status per
  host. Both now import one shared `mapCloudStatus` (`src/core/cloudStatus.ts`) whose
  case-insensitive switch is the union of the two tables. The standalone app's
  "latest activity" also sorted ISO timestamps lexically (wrong on mixed offsets); it now
  compares on `Date.getTime()`, matching the extension. (RUSH-1512)
- **The standalone Factory app now pauses its floor poll when the floor is hidden.** The
  Electron host handled `subscribeFloor` but dropped `unsubscribeFloor`, so its 5s poll —
  which shells out to read agent state and hit the cloud-runs API — kept running even when
  no floor was visible. It now stops on `unsubscribeFloor` and resumes on `subscribeFloor`,
  mirroring the VS Code host's `cleanupFloorWatchers` lifecycle. (RUSH-1509)

## [0.9.290] - 2026-07-08

### Added

- **Structured questions render on the card** — when an agent calls `AskUserQuestion`,
  the question text and its option labels now surface on the NEEDS-YOU card as clickable
  reply buttons. The data lived in the tool-call input all along; the card only read the
  agent's prose, so the question was invisible. Clicking an option delivers the answer
  back to the agent over its existing reply channel (terminal / tmux / cloud / team).
  (RUSH-453, RUSH-1521)

### Changed

- **Terminal detail pane now matches the headless/cloud panes** — the flat "Recent tools"
  list is replaced by the vertical progress timeline (oldest → now) plus a streaming
  "Latest" message rendered as markdown, so every agent's detail pane reads identically.
  Recent files span the full width. (RUSH-1519, RUSH-1546)

## [0.9.289] - 2026-07-08

### Fixed

- **0.9.288 failed to activate** — it was packaged without `node_modules`, so the
  extension host threw on `require()` of runtime deps (`ws`, `yaml`, MCP SDK, …) and
  no commands registered (`command 'agents.configure' not found`). Repackaged with
  dependencies included. The 0.9.288 card redesign is unchanged; this only restores
  the shipped dependencies.

## [0.9.288] - 2026-07-08

### Added

- **Readable agent cards on the Factory Floor.** Cards now lead with the agent's
  original **task** (not its last message), render **markdown** in message bodies,
  add a live **progress timeline** of recent tool calls plus a **streaming activity
  feed** of the agent's messages, keep the **todo checklist** from silently
  vanishing, and show a clean **worktree chip** instead of a raw `WT=/…/path`. The
  detail pane is reordered for legibility: Task → Progress timeline → Todos →
  Activity → PR/CI.

### Fixed

- **Shell (`SH`) tabs now load your full interactive shell environment.** Every
  tracked terminal — agent CLIs *and* bare shell tabs — carries `AGENT_TERMINAL_ID`,
  which rc files commonly use to take a minimal fast-path (skip oh-my-zsh, themes,
  plugins) for agent terminals no human types in. That mis-fired on the `SH` tab,
  which *is* an interactive shell you drive: it came up with a bare prompt, no theme,
  and missing aliases/tools. Factory now also exports **`AGENT_TERMINAL_KIND`**
  (`shell` for a bare shell tab, `agent` for an agent CLI terminal) so your rc file
  can tell them apart. Gate your fast-path on it, e.g. `zsh`:
  `if [[ -n "$AGENT_TERMINAL_ID" && "$AGENT_TERMINAL_KIND" != "shell" ]]; then …`.

## [0.9.286] - 2026-07-08

### Added

- **Factory Floor redesign — matches the approved prototype.** A cohesive pass over
  the whole dashboard:
  - **Icon rail** — compact left nav of icon buttons with count/needs badges
    (Agents · Needs · Backlog · Projects · Hosts); expands to the full text sidebar.
  - **Proper sub-tab strip** — the Floor's views (Agents / Backlog / Projects / Hosts)
    are now first-class tabs with count/needs badges, active-lime; Dispatch lives on the
    strip.
  - **One contextual controls bar** — the Group/Sort/filter controls swap to the active
    tab's set (agents Group/Sort vs backlog Group/Sort/LN/GH), so there's no more
    duplicated control bar. The old cluttered Status/Agent chip strip is gone — filtering
    lives in saved views + search.
  - **Double-click a task → its own closeable tab** — opens the full detail (rendered
    markdown, comments, images) with Dispatch right there; multiple task tabs at once.
  - **Human session labels** (`terminal-race-fix`, not `claude-596c4c07`) + a compact
    `<agent>·<id>` provenance chip; **project-link group headers** (`N agents` + Linear
    project pill).
  - **Detail-pane artifacts row** — the selected agent's PR / CI / spawned-team / created
    tickets as color-coded chips.
  - **Foreman corner FAB** — the voice orb is smaller and tucked into the corner.
  - **Grouped by project by default**, **checklist expanded by default** with the current
    step highlighted, **one-click PR link**, **created-ticket / spawned-team chips** on
    cards (backed by session scanning).

### Fixed

- **Markdown now renders in the ticket/task detail** instead of showing raw `##` /
  code-fences / `**bold**` (reuses the shared `renderTodoDescription` renderer).

## [0.9.284] - 2026-07-07

### Added

- **Factory Floor redesign — the card now shows the agent's outputs at a glance.**
  A cohesive pass over the live feed:
  - **Checklist expanded by default** on each card (still collapsible), with the
    current step highlighted so progress reads without a click.
  - **Feed grouped by project by default** (NEEDS YOU stays pinned above the groups).
  - **One-click PR link** — the `PR #N` pill is now a real link to the pull request.
  - **One unified search** — the TopBar center is the single live-feed filter; the
    duplicate search box in the Floor controls bar is gone (⌘K still opens the palette).
  - **Artifact chips** — cards surface the tracker refs the agent *created* (Linear
    `create_issue` / `gh issue create`) and any team it *spawned* (`agents teams
    create/add`), distinct from the injected/worked-on ticket. Backed by new session
    scanning (`createdTickets` / `spawnedTeam` on both the indexed scan and live
    session state).

### Fixed

- **Editor "Send to Agent" (slash-command + keyboard shortcut) silently did nothing.** The markdown editor webview may call VS Code's one-shot `acquireVsCodeApi()` only once per load, but `App.tsx` consumed it at startup while the Tiptap `KeyboardShortcuts` (`Mod-Shift-a` / `Mod-Shift-i`) and `SlashCommands` ("Send to Agent" / "Ask Agent") extensions each re-called `acquireVsCodeApi()` on use — a second acquisition that throws / yields `undefined`, so their `if (vscode)` guard fell through and the `postMessage` never fired. All four call sites plus `App.tsx` now share a single cached handle via a new `ui/editor/vscodeApi.ts` (`getVsCodeApi()`), acquired at most once. Regression test (`vscodeApi.test.ts`) simulates the single-acquire contract. Source: `apps/factory/ui/editor/vscodeApi.ts`, `App.tsx`, `extensions/KeyboardShortcuts.ts`, `extensions/SlashCommands.ts`.

## [0.9.283] - 2026-07-07

### Fixed

- **GitHub links pointed at a retired repo.** `package.json` `repository`, the
  settings "Open GitHub" action, and the Guide tab's "Learn More" link now all point
  to `github.com/phnx-labs/agents-cli` (`apps/factory`). Publish identity — publisher
  `swarmify`, name `swarm-ext`, appId — is unchanged.
- **Factory Floor feed showed identical, contextless cards for co-located sessions.**
  Ported the swarmify/extension feed fixes: fan-out remote-session enrichment now
  attributes each row to the correct device (`machine`), surfaces the worktree slug,
  live preview, structured ticket id, and real branch, and caches `startedAtMs` by
  PID so a terminal's start time no longer drifts to `Date.now()` on every republish.
  Consolidated the duplicated feed model into a single `@shared` implementation with
  a `MISSING_EXPORT` build-time drift guard.

### Added

- **tmux terminals by default** (`agents.terminalMode: auto | tmux | native`) with each
  agent terminal publishing its tmux pane (`%N`) and editor-tab index, surfaced as the
  pane handle and "viewing in <tab>" on Factory Floor cards. Gives same-cwd agents
  distinct, addressable identities.
- **tmux pane border now shows the live session label.** The border was seeded once with
  the bare agent code (e.g. `0: CC`) and never updated. It now tracks the same auto-label
  as the editor tab — the moment the session topic resolves (auto-label poller / focus
  fetch / manual rename), the border re-renders to `0: CC - <topic>` on the shared socket,
  even when the terminal isn't focused. This matters most when a session is reattached
  from a plain terminal outside the editor, where the border is the only label surface.
