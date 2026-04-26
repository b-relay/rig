# AGENTS.md - Rig 2 Development Guide

<!-- AGENTS.md is the source of truth. CLAUDE.md is a symlink to this file. DO NOT rename, delete, or revert this setup. -->

Rig is a local Mac deployment manager. Rig 2 is the replacement CLI runway for
Rig, built around `rig2`, isolated v2 state, `rigd` as the runtime authority,
Effect v4, Effect Schema, Effect CLI, and provider-backed modular interfaces.

## Default Workflow

- Use PRD skills for product planning:
  - Use `prd-to-plan` to turn PRDs into `plans/` files with tracer-bullet phases.
  - Use `prd-to-issues` to turn PRDs into independently grabbable GitHub issues.
  - Keep docs and plan files updated as implementation changes reality.
- Use `tdd` for implementation work:
  - Write one behavior test first.
  - Make it fail for the expected reason.
  - Implement the smallest vertical slice that makes it pass.
  - Refactor only after green.
- Prefer thin vertical slices over horizontal layer work. Each slice should be
  independently verifiable through public behavior.

## Effect v4

- Read `docs/effect-v4-help-notes.md` before changing Effect v4, Effect Schema,
  Effect CLI, Effect Platform, or Effect testing code.
- Treat `docs/effect-v4-help-notes.md` as repo-local memory. Update it when you
  verify a new Effect v4 API, migration detail, Bun integration pattern,
  package constraint, or gotcha.
- Prefer official Effect docs, `effect-smol`, and migration docs over older
  blog posts or Effect v3 examples.
- Rig 2 uses:
  - `effect-v4` for Effect services, layers, errors, and tests.
  - Effect Schema for v2 parsing and validation.
  - `effect-v4/unstable/cli` for `rig2` command parsing and help.

## Architecture Rules

- Design Rig 2 as interfaces first. External concerns must sit behind service
  interfaces and layers before command or core code uses them.
- Keep provider implementations swappable. First-party bundled providers and
  future external plugins should use the same provider contract shape.
- Core/runtime orchestration must depend on interfaces, not concrete provider
  modules.
- Keep `rigd` as the v2 runtime authority for lifecycle, deploy, inventory,
  health, logs, receipts, config editing, and control-plane contracts.
- Keep v2 isolated from v1 until cutover: no accidental writes to `~/.rig`,
  v1 launchd labels, v1 Caddy entries, or v1 runtime state.
- Enforce localhost-only bindings in schema validation: use `127.0.0.1` or
  localhost, never `0.0.0.0`.

## Code Rules

- Runtime: Bun.
- Language: TypeScript strict mode.
- Process management: `Bun.spawn` behind interfaces.
- Errors must be tagged classes with structured context and a useful hint.
- All output goes through the logger interface. Do not use `console.log`.
- Every schema field needs clear user-facing documentation.
- Every subcommand must support `--help` and `-h`.
- Keep files focused. Prefer one interface or provider responsibility per file.

## Commands

- `bun install`
- `bun test`
- `bun run build`
- `bun run build:rig2`

Run focused tests during TDD, then broader validation before committing when the
change touches shared behavior.

## Git Workflow

- Push directly to `main`.
- Use conventional commit messages: `feat:`, `fix:`, `test:`, `docs:`,
  `refactor:`, etc.
- Do not revert user changes unless explicitly asked.
