# Relay Harness

Relay is a local-first desktop multi-agent coding harness. Michael is the default orchestrator; Claude Code and Codex CLI workers operate in isolated Git worktrees on one coding project. The orchestrator name can be changed in the app.

The current implementation includes Milestones 01–17, from the technical foundation through shared orchestration, safety boundaries, persistent recovery, and full end-to-end validation. Michael uses the selected Claude or Codex model to inspect an objective, choose a saved team, produce a bounded execution plan, route worker blockers, and synthesize the final outcome. The complete lifecycle remains persisted through review, integration, verification, cleanup, activity history, recovery, reusable agent profiles, saved team templates, and the Relay control protocol.

## Development

Requirements:

- Node.js 22 or newer
- npm
- Git
- Claude Code and/or Codex CLI on `PATH`

```bash
npm install
npm run dev
```

Verification:

```bash
npm run typecheck
npm test
npm run build
```

Run the opt-in real CLI worktree smoke test. This invokes installed and authenticated
Claude Code and Codex CLI binaries in disposable Git repositories:

```bash
npm run test:cli
```

Run the complete local Milestone 17 gate (typecheck, automated suite, production build,
and both real CLI clients):

```bash
npm run test:e2e
```

The packaged-app acceptance flow is documented in
[FULL_E2E_CHECKLIST.md](FULL_E2E_CHECKLIST.md).

Create an unsigned macOS application bundle, or unsigned DMG and ZIP artifacts:

```bash
npm run pack:mac:unsigned
npm run dist:mac:unsigned
```

Signing, notarization, hardened runtime, and public macOS distribution are intentionally
deferred. See [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for the verified boundary.

The macOS bundle uses `build/relay-app-icon.icns`, while development mode uses
`build/relay-app-icon.png` for the live Dock icon. Their editable source is
`build/relay-app-icon.svg`.

## Architecture

```text
Electron main process
  ├── provider adapter registry + discovery
  ├── SQLite persistence
  ├── agent profile + team template registry
  ├── persistent orchestrator hive workspace
  ├── durable bidirectional control protocol
  ├── validated Michael action bridge
  ├── bounded live Monitor projection
  ├── Git repository + worktree manager
  ├── orchestrator planner + concurrent scheduler
  ├── read-only model planner + validated JSON plans
  ├── durable hive messages + blocker routing
  ├── read-only final outcome synthesis
  ├── structured logs
  ├── node-pty process supervisor
  ├── bounded terminal replay buffers
  └── typed IPC handlers
          │
          ▼
isolated preload contextBridge
          │
          ▼
React renderer
  ├── orchestrator command + live task board
  ├── reusable agent + template library
  ├── xterm.js terminal workspace
  ├── worktree creation + status screen
  ├── activity ledger + runtime health
  ├── persistent run defaults + recovery
  └── Zustand terminal state
```

The renderer has no direct Node access. Filesystem, database, Git, PTY, and provider operations remain in the Electron main process and are exposed through narrow typed IPC contracts.

## UI system

- Shadcn UI uses the `bcivVbaS` preset configuration: Base Nova, Base UI, Zinc tokens, Hugeicons, and CSS variables.
- Shared Button, Card, Input, Select, Tabs, Badge, Alert, Dialog, Separator, and Tooltip primitives live under `src/renderer/src/components/ui`.
- Renderer surfaces use the preset's neutral semantic tokens; provider and status colors are limited to explicit semantic roles.
- The startup wizard, orchestrator monitor and terminal, worker console, worktree workspace, empty/error states, selects, tooltips, and rename editor share one spacing, border, type, and focus treatment.
- Compact-height and narrow-window rules preserve usable controls without introducing custom component sizes.
- Renderer design-system invariants are covered by the automated test suite and the production build is the final verification gate.

## Orchestrator hive

On first launch, Relay starts with no project selected. Its startup wizard asks for a Harness Home and a Git project. Relay stores its database and coordination state in the chosen Harness Home:

```text
Harness Home/
  relay.db
  hive/
    PROTOCOL.md
    registry.json
    board.md
    tasks.json
    log.jsonl
    messages.jsonl
    control/
      inbox/
      outbox/.processing/
      outbox/.done/
      results/
      actions/
    agents/orchestrator/
      identity.md
      memory.md
      context.md
      history.jsonl
      cursor.json
      inbox/.done/
      outbox/.sent/
```

Michael's identity is refreshed by the harness while `memory.md` is never overwritten. Renaming the orchestrator updates its identity and registry without moving its stable folder. The structured task ledger mirrors persisted orchestration runs and remains readable independently of the UI.

## Persistent memory and recovery

- `memory.md` remains Michael's curated long-term memory; Relay never replaces it.
- Human inputs, final run states, action outcomes, and recovery events are deduplicated into the append-only `history.jsonl` journal.
- Relay projects the latest 30 entries into `context.md`, and every fresh Michael CLI session reads both memory files before accepting work.
- Control commands remain immutable in `control/inbox/`; commands without a matching acknowledgment in `control/.done/` are replayed after restart.
- Each accepted action crosses a durable `control/actions/` execution boundary before Relay mutates state.
- A completed receipt is reused, while an action left `executing` by a crash is quarantined and reported for inspection instead of being run twice.
- Automatic and manual recovery retain interrupted runs as blocked, refresh Hive projections, replay pending controls, drain recoverable actions, and preserve every worktree and branch.

## Safety boundaries

- The Electron main process authorizes every repository, worktree, run, task, and terminal request against the currently selected project.
- Renderer requests cannot inspect another repository, operate on historical runs from another project, assume an internal terminal role, choose an arbitrary terminal directory, or inject provider CLI arguments.
- Every denied boundary request is recorded as an `app.safety.denied` system event.
- Michael's persistent CLI runs from the Hive instead of the main checkout. Claude starts in restricted safe mode with file tools confined to the Hive; Codex uses its workspace-write sandbox rooted in the Hive.
- Worker terminals may start only in the selected checkout or a live Git-registered worktree. Relay-created agents still receive dedicated project-local worktrees.
- Relay refuses symlinked Hive control directories and managed worktree storage that resolves outside the selected project.
- CLI child processes receive a small environment allowlist for provider authentication and basic terminal operation instead of inheriting every host secret.
- Relay's own Git commands disable repository hooks, disable terminal prompts, use argument arrays without a shell, and inherit only the environment needed for local Git operations.

## Unified orchestrator input

- Monitor and Terminal use the same rich composer and persistent Michael session.
- Human input is persisted before delivery; it never goes directly to a worker.
- Michael may answer in the terminal or request a Monitor action through `control/outbox/`.
- Relay accepts only the documented version-1 action allowlist and validates every identifier, provider, strategy, decision, and concurrency value in the main process.
- Relay remains the sole owner of worker launch, worktrees, review, integration, verification, and cleanup.
- Completed and rejected action receipts are durable under `control/results/` and are delivered back to Michael's session.

## Live Monitor projection

- Monitor shows Michael's current session state, four recent terminal lines, and three short semantic activity events.
- The projection reads the existing persistent PTY; it never starts or emulates another orchestrator session.
- ANSI escape sequences and control characters are removed in the main process before renderer delivery.
- Raw projection input is capped at 64 KiB, visible output at eight lines, and updates are throttled.
- Terminal remains the complete interactive transcript and can be opened directly from the projection card.

## Terminal safety

- Provider commands are resolved without a shell.
- Terminal input is serialized per PTY.
- Input and terminal dimensions are bounded at the IPC boundary.
- Tab switching and renderer reloads replay a bounded main-process buffer.
- Stop first sends a graceful process-tree signal and escalates to a forced kill.
- App shutdown force-stops every remaining PTY process tree.
- Planner, worker, synthesis, and verification phases have watchdog timeouts.
- CLI authentication, permissions, usage limits, network failures, and non-zero exits are translated into actionable errors.
- Retained terminal output is capped at 1 MiB per session and exited sessions are pruned.

## Worktree safety

- Git commands run without a shell and have bounded output and execution time.
- Managed worktrees live inside each project under `.relay/worktrees/`, matching the project-local workflow used by Claude Code.
- Relay adds `/.relay/worktrees/` to the repository's local `.git/info/exclude`; it does not modify the tracked `.gitignore`.
- Legacy worktrees under Harness Home remain discoverable and removable.
- Worktree and branch names are validated before reaching Git.
- Removal refuses dirty worktrees and branches with commits ahead of their base.
- A worktree cannot be removed while a live terminal is using it.
- Missing worktrees remain visible and can be forgotten without touching repository content.
- Removing a worktree leaves its Git branch intact for recovery.

## Orchestration lifecycle

- Build mode assigns an implementation owner and an independent reviewer.
- Split mode turns newline or semicolon-separated instructions into parallel workstreams.
- Audit mode asks each worker for an independent, evidence-backed investigation.
- Every task carries an explicit role, assignment, and expected deliverable.
- Every task receives a dedicated `relay/orchestrator-*` branch and managed worktree.
- Claude runs in non-interactive edit-accepting mode; Codex runs in a workspace-write sandbox with approvals disabled inside its isolated checkout.
- Run and task states are persisted in SQLite and interrupted work is surfaced as blocked after restart.
- Runs support bounded concurrency, stop, and task retry.
- Worker output is retained in the terminal replay buffer and summarized when the process exits.

## Integration lifecycle

- Completed worker results expose a bounded per-file diff without changing Git state.
- Every task must be explicitly accepted or rejected before integration begins.
- Accepted tasks are squashed and applied to the checked-out base branch in task order.
- Integration refuses a dirty project checkout or the wrong checked-out branch.
- Conflicts are reported by file and aborted without leaving the project in a conflicted state.
- Final verification runs through an available CLI in read-only mode and retains its report.
- Cleanup removes completed managed worktrees only after verification; task branches remain for recovery.

## Operations lifecycle

- Activity presents the append-only SQLite event ledger with run, Git, terminal, and system filters.
- Run mode, agent concurrency, and preferred verifier defaults persist inside the selected Harness Home.
- Runtime health reports active terminals, running orchestrations, managed worktrees, and event volume.
- Recovery marks interrupted work as blocked, repairs hive projections, and reports missing worktrees without deleting branches or files.

## Extensibility lifecycle

- Claude Code and Codex are represented by one provider-adapter contract for discovery, worker launch, and read-only verification.
- Reusable agent profiles store a person name, animated DiceBear avatar seed, CLI provider, optional model, instructions, and enabled state.
- Multiple profiles may use the same CLI, allowing specialized workers to run concurrently in separate worktrees.
- Team templates save an objective, run mode, concurrency, and up to four agent profiles.
- The orchestrator command surface can load a template or select individual saved agents before a run.
- Custom data never becomes an executable command: provider commands remain fixed and model identifiers are passed as bounded argument values without a shell.

## Intelligent orchestration lifecycle

- Every new run starts in a persisted planning state and launches Michael through the engine and model selected at startup.
- Planning runs in Claude plan mode or the Codex read-only sandbox and cannot modify the repository.
- Michael receives the objective, run mode, available providers, and eligible saved-agent roster, then returns a one-to-four-task JSON plan.
- Relay validates every title, role, deliverable, provider, and profile assignment before creating worktrees.
- Invalid output, a missing planner, or a non-zero planner exit automatically produces a deterministic fallback plan instead of stranding the run.
- Planner transcripts remain available in Console, while the monitor shows plan source, rationale, and fallback errors.
- Failed, blocked, or stopped runs expose an explicit Re-plan action that creates a fresh model-planned run without mutating historical results.
- Re-plans retain a parent-run link and send prior blocker evidence to Michael, so replacement tasks address the failed approach while preserving history.
- Workers can emit a bounded `RELAY_BLOCKER` report; Relay turns it into a blocked task plus a durable message in Michael's hive inbox and `messages.jsonl` stream.
- After the workers finish, Michael runs in a read-only synthesis terminal and publishes one compact outcome; a deterministic summary is retained if the model is unavailable or malformed.
- Planning, blocker, synthesis, and task state are projected into the hive board, inbox, message stream, and structured task ledger.

## Release readiness

- Startup canonicalizes the selected paths, verifies a writable Harness Home, requires a Git repository on a checked-out branch, and rejects overlapping Harness Home and project folders.
- Electron denies renderer permission requests and unexpected top-level navigation; the renderer remains isolated behind the preload bridge and a restrictive Content Security Policy.
- Provider discovery is cached and de-duplicated to keep startup and refresh work bounded.
- Native packages are pruned to the Darwin architecture required by the generated bundle.
- Automated release checks cover onboarding persistence, permission policy, package configuration, watchdogs, bounded buffers, workspace validation, and both provider adapters.
- The macOS application does not need Accessibility or Screen Recording permission. Those permissions are only needed by external UI-automation tools used to inspect the app.
