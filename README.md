# Relay Harness

Relay is a local-first desktop multi-agent coding harness. Michael is the default orchestrator; Claude Code and Codex CLI workers operate in isolated Git worktrees on one coding project. The orchestrator name can be changed in the app.

The current implementation includes Milestones 01–09, from the technical foundation through intelligent orchestration. Michael uses the selected Claude or Codex model to inspect an objective, choose a saved team, produce a bounded execution plan, route worker blockers, and synthesize the final outcome. The complete lifecycle remains persisted through review, integration, verification, cleanup, activity history, recovery, reusable agent profiles, and saved team templates.

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

Create the macOS application and DMG:

```bash
npm run dist:mac
```

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

On first launch, Relay starts with no project selected. Its startup wizard asks for a Harness Home and a Git project. Relay keeps only that selection in application data; the operational workspace is created in the chosen Harness Home:

```text
Harness Home/
  relay.db
  worktrees/
  hive/
    PROTOCOL.md
    registry.json
    board.md
    tasks.json
    log.jsonl
    messages.jsonl
    agents/orchestrator/
      identity.md
      memory.md
      cursor.json
      inbox/.done/
      outbox/.sent/
```

Michael's identity is refreshed by the harness while `memory.md` is never overwritten. Renaming the orchestrator updates its identity and registry without moving its stable folder. The structured task ledger mirrors persisted orchestration runs and remains readable independently of the UI.

## Terminal safety

- Provider commands are resolved without a shell.
- Terminal input is serialized per PTY.
- Input and terminal dimensions are bounded at the IPC boundary.
- Tab switching and renderer reloads replay a bounded main-process buffer.
- Stop first sends a graceful process-tree signal and escalates to a forced kill.
- App shutdown force-stops every remaining PTY process tree.

## Worktree safety

- Git commands run without a shell and have bounded output and execution time.
- Managed worktrees live under the user-selected Harness Home.
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
