# TODO

## Future CLI Shape To Discuss

### Default to the current repo/project instead of accepting an explicit project name

- Goal:
  - stop making the project name a normal positional argument for commands like `start`, `stop`, `deploy`, and `status`
  - default to the current repo/project automatically
  - only allow targeting a different registered project with an explicit override flag
- Desired direction:
  - `rig start dev`
  - `rig deploy prod`
  - `rig status`
  - then something like `-P <name>` or another explicit selector when operating on a different project
- Why this is worth discussing:
  - the common case is “operate on the project I am in”
  - it reduces repetitive/ambiguous command shapes for humans and AI agents
  - it pushes cross-project operations behind a more explicit path
- Still needs discussion:
  - the final override flag name
  - how this interacts with running outside a repo
  - whether path-based targeting should also be supported explicitly

## Rig Test Isolation To Discuss

### Replace `rig-smoke` with normal `rig` plus isolated `RIG_ROOT`

- Goal:
  - make the default `rig` binary safe to run against a temporary isolated rig root for end-to-end testing
  - reduce the need for a separate compiled `rig-smoke` binary over time
- Desired direction:
  - use `RIG_ROOT=/tmp/...` to isolate registry, workspaces, versions, bins, and other rig-managed state
  - keep any unsafe system integrations behind explicit test-safe wiring
- Why this is worth discussing:
  - less duplicate binary/build surface
  - closer parity between test execution and the real shipped CLI
  - easier ad hoc local validation without touching the user’s actual rig state
- Still needs discussion:
  - whether `rig-smoke` should disappear completely or remain as a thin test harness
  - how launchd and other system integrations should be safely stubbed in the default binary path

## Smoke-Discovered Bugs To Discuss

These came from exploratory runs against the compiled `rig-smoke` binary.
They look like real bugs, but the exact fixes and product behavior still need discussion before implementation.

### 1. Release tags and prod workspaces can point at stale `rig.json` contents

- Repro:
  - `rig-smoke init pantry --path <repo>`
  - `rig-smoke deploy pantry prod --bump minor`
- Observed:
  - repo `rig.json` becomes the bumped version
  - the git tag and deployed prod workspace can still contain the old `version`
- Why this looks wrong:
  - release metadata and deployed config drift apart
  - `status` can show `latest/current` as one version while the deployed workspace config reports another
- Potential solutions:
  - require release bumps to happen on a committed tree and create a real version-bump commit before tagging
  - or create the release from a generated detached tree/worktree that contains the bumped `rig.json` and history files
  - or stop mutating repo files before tagging and move release state somewhere fully derived from git metadata
- Still needs discussion:
  - whether prod releases are supposed to create commits automatically
  - whether `rig.json.version` is meant to be committed release state or just local working state

### 2. Dirty worktrees are not blocked for release-changing deploys

- Repro:
  - modify a tracked file without committing
  - run `rig-smoke deploy pantry prod --bump minor`
- Observed:
  - release creation still succeeds
- Why this looks wrong:
  - release tags then point at old commits while local files contain unreleased changes
  - this makes release provenance ambiguous
- Potential solutions:
  - block `deploy ... prod --bump ...` whenever `git isDirty` is true
  - allow an explicit force-style escape hatch later if we ever want one, but default to hard-fail
- Still needs discussion:
  - whether there should ever be a force path
  - whether ignored/untracked files should count as dirty for release purposes

### 3. Prod deploy can report success even when new services immediately die with `EADDRINUSE`

- Repro:
  - start dev services
  - deploy prod using the same ports
- Observed:
  - deploy logs success
  - the new prod service processes die immediately
  - health checks pass because the already-running dev services answer on those ports
- Why this looks wrong:
  - prod deploy can claim success while the deployed runtime never actually came up
- Potential solutions:
  - strengthen port preflight so it detects all listeners the real service bind would collide with
  - make health validation process-aware, not only port/HTTP-aware
  - verify the started PID is still alive after health passes and before success is logged
  - record which PID owns the listening port and ensure it matches the newly started service tree
- Still needs discussion:
  - whether same-port dev/prod coexistence should be categorically disallowed
  - whether health should be tied to PID, port ownership, or both

### 4. `status <name> prod --version <undeployed>` warns and succeeds instead of failing

- Repro:
  - `rig-smoke status pantry prod --version 0.1.0` when that prod version is not deployed
- Observed:
  - warning log
  - table output
  - exit code `0`
- Why this looks wrong:
  - explicit version targeting on other commands fails hard when the version is missing
  - `status --version` currently behaves inconsistently and can look like success
- Potential solutions:
  - make explicit undeployed prod versions a hard error in `status`
  - keep the current warning-only path only for non-versioned broad status views
- Still needs discussion:
  - whether `status --version` should be strict like `logs/start/stop`
  - whether there is any user value in the current warning-plus-fallback behavior

### 5. `logs` across all services breaks when an environment includes `bin` services

- Repro:
  - configure an environment with server services plus a `bin` service
  - run `rig-smoke logs pantry prod`
- Observed:
  - command fails because structured history is missing for the `bin` service
- Why this looks wrong:
  - `bin` services are not long-running runtime logs in the same sense as server services
  - one logless service can block all-service log viewing
- Potential solutions:
  - exclude `bin` services from aggregate logs by default
  - or include them only when they have an actual log artifact
  - or show server logs and emit a warning about services without runtime logs instead of failing
- Still needs discussion:
  - whether `rig logs` should mean “runtime services only” or literally every service entry
  - how `bin` services should appear in `logs`, if at all
