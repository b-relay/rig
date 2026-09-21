# Rig Development Guide

Rig is a local Mac deployment manager built around `rigd` as the runtime
authority, strict TypeScript, Bun, Zod validation, and provider-backed modular
interfaces. Rig does not use Effect TS.

## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues on `b-relay/rig`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`) plus `in-progress` and `in-review`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See
`docs/agents/domain.md`.

## Default Workflow

- Prefer thin vertical slices over horizontal layer work. Each slice should be
  independently verifiable through public behavior.

## TypeScript implementation

- Use plain TypeScript functions, explicit dependency interfaces, async/await,
  and structured tagged errors.
- Validate external input with Zod; keep domain calculations independent of I/O.
- Follow `function-design` and the current PRD issue. Keep contract ledgers and
  review evidence in `docs/reviews/`, not scattered through production code.
- Run review subagents after each major milestone and resolve material findings
  before marking the milestone complete.

## Architecture Rules

- Design Rig as interfaces first. External concerns must sit behind service
  interfaces and adapters before command or core code uses them.
- Keep interfaces in the domain language. Callers should depend on capabilities
  like config, process execution, filesystem, git, logging, health checks,
  deploy orchestration, providers, and plugins, not concrete tools.
- Keep provider implementations swappable. First-party bundled providers and
  future external plugins should use the same provider contract shape.
- Core/runtime orchestration must depend on interfaces, not concrete provider
  modules.
- Keep `rigd` as the rig runtime authority for lifecycle, deploy, inventory,
  health, logs, receipts, preflight, and control-plane contracts.
- Keep tests and agent runs isolated with `RIG_ROOT`; do not accidentally mutate
  the user's real rig state, launchd labels, Caddy entries, or runtime state.
- Local development is the Working copy Target. Branch/Commit deploys drive the
  Stable Target and Previews; `main` is the default Production branch unless
  Project config says otherwise.
- Enforce localhost-only bindings in schema validation: use `127.0.0.1` or
  localhost, never `0.0.0.0`.

## Code Rules

- Runtime: Bun.
- Language: TypeScript strict mode.
- Process management: keep concrete process APIs behind provider interfaces.
- Errors must be tagged classes with structured context and a useful hint.
- Human output goes through the user-output interface; diagnostic evidence goes
  through the diagnostic-log interface. Do not use `console.log`.
- Every schema field needs clear user-facing documentation.
- Every subcommand must support `--help` and `-h`.
- Keep files focused. Prefer one interface or provider responsibility per file.

## Commands

- `bun install`
- `bun test`
- `bun run typecheck`
- `bun run build`

Run focused tests during TDD, then broader validation before committing when the
change touches shared behavior.

## Git Workflow

- Use conventional commit messages: `feat:`, `fix:`, `test:`, `docs:`,
  `refactor:`, etc.
- Do not revert user changes unless explicitly asked.
