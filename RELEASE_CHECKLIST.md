# Relay release checklist

Milestone 17 validates a local, unsigned macOS release. Signed and notarized macOS
distribution is a later milestone.

## Required gates

```bash
npm install
npm run typecheck
npm test
npm run build
npm run test:cli
npm run test:e2e
npm run dist:mac:unsigned
```

`npm run test:cli` is intentionally opt-in because it launches the locally installed
Claude Code and Codex CLI clients. Both clients must already be authenticated. The test
uses disposable repositories and isolated Git worktrees, confirms read-only planning
does not change the project, confirms worker changes remain in their worktree, and does
not create commits.

`npm run test:e2e` is the repeatable local Milestone 17 gate. It combines type checking,
the complete automated suite, the production renderer/main build, and both authenticated
real-CLI smoke tests. Packaged UI acceptance remains a separate human-style run because
it exercises native dialogs, window state, and visual terminal behavior.

## Onboarding checks

- Relay opens the startup verification dialog on every launch.
- A Harness Home and Git project must be selected before Relay can open.
- Harness Home is created when needed and must be readable and writable.
- The project must be a Git worktree with a checked-out local branch.
- Harness Home and project cannot contain one another.
- Michael's provider and model are reverified at startup.
- A first-use Claude trust dialog is confirmed only for Relay's generated Hive agent
  directory; Relay waits for the real CLI prompt before delivering queued control input.
- Missing CLIs and invalid paths produce visible, actionable errors.

## Runtime checks

- Renderer permission requests are denied by default.
- Unexpected navigation is blocked and HTTPS links open externally.
- Planner, worker, synthesis, and verification phases stop after bounded watchdogs.
- Provider authentication, filesystem permission, usage-limit, network, and generic
  command failures have distinct messages.
- Terminal replay retains at most 1 MiB per session.
- No more than 12 live PTYs or 64 retained sessions are allowed.
- Provider discovery is cached for 10 seconds and concurrent checks are de-duplicated.
- Unexpected renderer exits and unresponsive states are logged.
- Unified input is queued to the persistent Michael PTY instead of sent directly to a worker.
- Michael action files are allowlisted and validated before the main process executes them.
- Malformed, unknown, or out-of-bounds actions produce durable rejected receipts.
- Monitor projection follows only the persistent orchestrator PTY, strips terminal controls,
  and bounds raw input, visible lines, event history, and update frequency.
- Fresh Michael sessions load curated memory plus Relay's bounded recent-context projection.
- Unacknowledged control commands replay after restart without replacing their audit files.
- Completed action receipts are reused and crash-interrupted actions are quarantined rather
  than executed a second time.
- Main-process safety policy scopes repository, worktree, run, task, and terminal IPC to the
  selected project and audits every denial.
- Renderer terminal requests cannot select privileged roles, internal output modes, custom
  provider arguments, or directories outside registered project worktrees.
- Michael runs from a restricted Hive workspace, Relay-owned Hive directories reject symlinks,
  and managed worktree storage cannot resolve outside the project.
- Provider processes receive only the bounded terminal and authentication environment allowlist.
- Relay-owned Git mutations disable repository hooks and terminal prompts and use a reduced child environment.

## Full E2E acceptance

Follow [FULL_E2E_CHECKLIST.md](FULL_E2E_CHECKLIST.md) against the packaged app. The
acceptance run must cover startup, one shared Michael session, a split Claude + Codex
run, project-local worktrees, live terminals, review, integration, verification,
restart recovery, activity history, extensions, traversal rejection, and cleanup.

## Unsigned package

Expected Apple Silicon artifacts:

```text
dist/mac-arm64/Relay.app
dist/Relay-0.1.0-arm64.dmg
dist/Relay-0.1.0-arm64.zip
```

The package uses ASAR and carries only production dependencies plus required Darwin
native modules. It has no signing identity, hardened runtime, notarization ticket, or
Gatekeeper assessment. Another Mac may warn or refuse to open it until signed release
work is completed.

## Deferred distribution work

- Apple Developer ID certificate and secure CI secret handling
- Hardened runtime and entitlements
- Notarization and stapling
- Gatekeeper verification on a clean macOS machine
- Update channel, release publishing, and rollback policy
