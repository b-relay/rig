# AGENTS.md — Rig Development Guide

<!-- AGENTS.md is the source of truth. CLAUDE.md is a symlink to this file. DO NOT rename, delete, or revert this setup. -->

## What is Rig?
Local Mac deployment manager. See DESIGN.md for full spec.

## Tech Stack
- Runtime: Bun
- Language: TypeScript (strict mode)
- Error handling: Effect TS
- Schema validation: Effect Schema for v2; legacy Zod only during migration
- CLI parsing: Effect CLI for v2; legacy hand parsing only during migration
- Process management: Bun.spawn

## Effect v4 Notes
- Read `docs/effect-v4-help-notes.md` before implementing or reviewing Effect v4, Effect Schema, Effect CLI, Effect Platform, or Effect testing work.
- Treat `docs/effect-v4-help-notes.md` as living repo-local memory. Update it when you verify a new Effect v4 API, migration detail, Bun integration pattern, package version constraint, or gotcha that would help the next agent.
- Prefer official Effect docs, `effect-smol`, and migration docs over older blog posts or v3 examples. Record useful source links in `docs/effect-v4-help-notes.md`.
- If Effect v4 is still prerelease, pin the exact beta intentionally and document the planned stable upgrade path in code/docs touched by the change.

## Commands
- `bun install` — install deps
- `bun run build` — build
- `bun test` — run tests

## Architecture Rules
1. ALL external concerns go through interfaces (src/interfaces/)
2. Core logic (src/core/) NEVER imports from providers directly
3. Every schema field must have clear user-facing docs
4. Every error must be a tagged class with structured context + hint
5. Use Effect TS Services and Layers for dependency injection
6. Never use console.log — all output through Logger interface
7. All subcommands must support --help, -h
8. Enforce 127.0.0.1 only (never 0.0.0.0) in schema validation

## Git Workflow
- Push directly to main — no PRs, no feature branches
- Commit messages: conventional commits (feat:, fix:, test:, refactor:, etc.)

## Code Style
- Use tagged error classes (readonly _tag = "ErrorName")
- Prefer pipe/Effect.gen over raw promises
- Keep files focused — one interface or provider per file
- Export types from interfaces, implementations from providers
