# Relay Harness

Relay is a local-first desktop multi-agent coding harness. Michael is the default orchestrator; Claude Code and Codex CLI workers operate in isolated Git worktrees on one coding project. The orchestrator name can be changed in the app.

The current implementation includes **Milestone 01: technical foundation**, **Milestone 02: terminal plane**, **Milestone 03: Git worktree plane**, and **Milestone 04: orchestration core**. Michael accepts one objective, decomposes it across available CLI workers, provisions isolated worktrees, runs Claude Code and Codex non-interactively, and persists the complete run lifecycle.

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

## Architecture

```text
Electron main process
  ├── provider discovery
  ├── SQLite persistence
  ├── persistent orchestrator hive workspace
  ├── Git repository + worktree manager
  ├── orchestrator planner + concurrent scheduler
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
  ├── xterm.js terminal workspace
  ├── worktree creation + status screen
  └── Zustand terminal state
```

The renderer has no direct Node access. Filesystem, database, Git, PTY, and provider operations remain in the Electron main process and are exposed through narrow typed IPC contracts.

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
