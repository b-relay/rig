# CLAUDE.md — Rig Development Guide

## What is Rig?
Local Mac deployment manager. See DESIGN.md for full spec.

## Tech Stack
- Runtime: Bun
- Language: TypeScript (strict mode)
- Error handling: Effect TS
- Schema validation: Zod
- Process management: Bun.spawn

## Commands
- `bun install` — install deps
- `bun run build` — build
- `bun test` — run tests

## Architecture Rules
1. ALL external concerns go through interfaces (src/interfaces/)
2. Core logic (src/core/) NEVER imports from providers directly
3. Every Zod field must have .describe() with clear docs
4. Every error must be a tagged class with structured context + hint
5. Use Effect TS Services and Layers for dependency injection
6. Never use console.log — all output through Logger interface
7. All subcommands must support --help, -h
8. Enforce 127.0.0.1 only (never 0.0.0.0) in schema validation

## Code Style
- Use tagged error classes (readonly _tag = "ErrorName")
- Prefer pipe/Effect.gen over raw promises
- Keep files focused — one interface or provider per file
- Export types from interfaces, implementations from providers
