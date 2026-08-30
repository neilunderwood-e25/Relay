# Relay full E2E checklist

Milestone 17 validates Relay as a person would use the packaged macOS app. Use an
isolated Harness Home and a disposable Git project. The selected project must begin on
a clean local branch with at least one commit. Signed distribution remains deferred.

## Automated gate

Both Claude Code and Codex CLI must be installed and authenticated.

```bash
npm run test:e2e
npm run pack:mac:unsigned
```

Expected: type checking, the full Vitest suite, the production build, both real CLI
worktree smoke tests, and unsigned app packaging all pass.

## Packaged startup

- Launch `dist/mac-arm64/Relay.app` with an isolated Electron user-data directory.
- Confirm the startup dialog appears even when a prior workspace exists.
- Select the isolated Harness Home and disposable Git project.
- Confirm the chosen Michael engine/model and open Relay.
- Verify Michael runs from `hive/agents/orchestrator`, not the selected checkout.
- On a fresh Claude workspace, verify Relay accepts only the Hive trust prompt and does
  not deliver a queued objective until Claude reaches its real prompt.

## Real multi-agent run

- Choose Split mode, enable Claude and Codex, and submit two independent file changes.
- Confirm the objective is persisted before delivery and appears once in run history.
- Confirm Michael plans two tasks and Relay starts both workers concurrently.
- Confirm every worker gets a random person name, provider mark, and unique avatar.
- Confirm worktrees are created under `<project>/.relay/worktrees/` on `relay/*` branches.
- Open Console and verify live Claude and Codex output appears before each process exits.
- Confirm the main checkout stays unchanged until integration.

## Review through cleanup

- Open every completed task and inspect its bounded diff.
- Accept the expected changes and confirm Integrate remains disabled until all tasks are reviewed.
- Integrate and confirm the main checkout is clean with one Relay commit per accepted task.
- Run verification and require an explicit passing report before Cleanup is enabled.
- Clean up the run and confirm managed worktree directories are removed while their Git
  branches remain available for recovery.

## Persistence and operations

- Restart the app before cleanup and reconfirm the workspace at startup.
- Confirm the run, reviews, integration commits, verification report, worktrees, saved
  agents, saved templates, activity events, and Michael memory survive the restart.
- Run manual recovery and require a visible healthy result when no interrupted state exists.
- Confirm Activity filters separate run, Git, terminal, and system events.
- Confirm Settings reports both CLIs ready and accurate terminal/run/worktree counts.

## Safety and errors

- Reject a worktree name such as `../escape` before Git receives it.
- Reject overlapping Harness Home/project paths and a non-Git project during startup.
- Refuse cleanup of dirty, ahead, or terminal-owned worktrees.
- Stop an active run and confirm its worker process tree exits and the durable run remains inspectable.
- Relaunch with an unacknowledged control input and confirm it is replayed once, without
  duplicating its Monitor action or worktrees.
- Confirm malformed or out-of-scope action files receive durable rejected results and an
  `app.safety.denied` audit event where applicable.

Record CLI versions, packaged Relay version, test project commit, and any deviations in
the release notes for the candidate build.
