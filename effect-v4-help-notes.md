# Effect v4 + Bun + Codex notes

Last updated: 2026-04-19

## How to use this file

This is repo-local working memory for Rig's Effect v4 migration. Read it before implementing or reviewing Effect v4, Effect Schema, Effect CLI, Effect Platform, or Effect testing work.

Keep this file current as you learn. When you verify an API, package version constraint, migration rule, Bun integration detail, or project-specific gotcha, update the relevant section and add a source link when possible. Prefer small factual notes over long essays.

## TL;DR

- **Effect v4 is in beta**. The official beta post says v4 is beta and points to the migration guides. For production, treat APIs as still settling.
- **For Bun**, the official docs support Bun directly, and the v4 beta post shows `bun add effect@beta`.
- **Helpful first-party tooling**:
  - `@effect/language-service`
  - `@effect/eslint-plugin`
  - `create-effect-app`
  - `@effect/platform` + `@effect/platform-bun` when you want platform abstractions like `Command`, `FileSystem`, `Terminal`, etc.
- **Best current v4-first references** are the `effect-smol` repo + migration docs, then community projects like `effect-solutions`.
- **Public community skills/plugins for Effect do exist now**, but they are not concentrated in one official OpenAI directory yet.

## Bun-first setup

### Start a fresh Bun project

Official Effect installation docs for Bun:

```bash
mkdir hello-effect
cd hello-effect
bun init
bun add effect
bun index.ts
```

The docs also explicitly say Bun is supported, and that `strict: true` should be enabled in `tsconfig.json`.

### If you specifically want v4 beta

The official Effect v4 beta post shows:

```bash
bun add effect@beta
```

### Scaffold from the official starter

The official `create-effect-app` release post includes Bun usage:

```bash
bunx create-effect-app@latest
```

That tool can bootstrap from templates or the official example app.

## Packages worth adding in a Bun-based Effect repo

### 1) Effect Language Service

Why:
- Effect-aware diagnostics
- completions
- automated refactors
- useful v4 migration/outdated-API checks

Install:

```bash
bun add -D @effect/language-service
```

Notes:
- Official docs call this the **Effect LSP**.
- The GitHub repo says it works as a TypeScript language service plugin.
- Recent releases explicitly mention v4 support / v4 harness updates.

### 2) Effect ESLint plugin

Why:
- dedicated rules for Effect code
- useful if you want your repo nudged toward Effect idioms

Install:

```bash
bun add -D @effect/eslint-plugin
```

### 3) Effect Platform + Bun platform package

Why:
- if you want `Command`, `FileSystem`, `Path`, `Terminal`, etc.
- the platform docs explicitly say `@effect/platform` targets Node, Deno, Bun, and browsers, and that Bun uses `@effect/platform-bun`

Install:

```bash
bun add @effect/platform @effect/platform-bun
```

### 4) Effect test integration

If you want Effect-native testing patterns, add:

```bash
bun add -D vitest @effect/vitest
```

The Effect repo's own `AGENTS.md` says to prefer `it.effect` and import `{ assert, describe, it }` from `@effect/vitest` for Effect-based tests.

## The most useful v4-first sources right now

### 1) `effect-smol` (official v4 repo)

This is the most important official v4 source right now.

Why it matters:
- repo description says it is **"Core libraries and experimental work for Effect v4"**
- it contains the main migration docs
- it contains `ai-docs/`, `migration/`, and the packages themselves

If you want v4-native examples and migration truth, start here first.

### 2) Official migration docs

Read these together:

- `MIGRATION.md` - high-level v3 -> v4 migration guide
- `migration/schema.md` - schema-specific migration guide

These are the cleanest official references for renames, API shifts, and behavior changes.

### 3) `effect-solutions`

This is one of the best public community references I found for **idiomatic Effect patterns**, and it is very Bun-friendly.

Why I would use it:
- explicitly positioned as **"Effect best practices and patterns"**
- designed for humans **and AI agents**
- includes a CLI you can run with `bunx effect-solutions ...`
- examples in the README already use modern imports like `import { Effect } from "effect"`

This is not the official v4 repo, but practically it is one of the best places to crib patterns from.

### 4) `Effect-TS/examples`

Useful, but with an important caveat:
- it is the official examples/templates repo
- `create-effect-app` points to it
- but the surfaced examples are still pretty sparse right now; the repo page currently highlights `http-server` plus templates like `basic`, `monorepo`, and `cli`

So I would treat this as a starter/scaffolding repo, not the whole story for v4 learning.

### 5) Ethan Niser's `effect-workshop`

Good learning repo if you want something hands-on and Bun-friendly.

Why it stands out:
- Bun is explicitly listed as the **recommended** runtime
- the repo is organized into snippets, exercises, breakpoints, projects, and a cheatsheet
- commands are set up around `bun run ...`

I would use this for learning workflow, even though it is not the canonical official v4 repo.

## Community public skills / plugins / skill repos for Effect

These are the most relevant public ones I found.

### 1) `joelhooks/effectts-skills`

Probably the strongest public **Effect-v4-specific skill/plugin** I found.

Why it looks useful:
- the repo explicitly says it is an **Effect-TS v4** skill/plugin
- install options include:
  - `npx plugins add joelhooks/effectts-skills`
  - `npx skills add joelhooks/effectts-skills`
- it includes docs/scaffold commands for services, layers, schemas, errors, testing, HTTP, CLI, config, and processes
- it explicitly cites `effect-solutions`, `effect-ts/effect`, and `artimath/effect-skills` as source bases

If you want one community-made package that looks closest to "ready to use", this is the first one I would inspect.

### 2) `agustif/effect-v4-skill`

More focused and smaller, but clearly aimed at v4 migration/review.

What it says it contains:
- `SKILL.md`
- migration map
- idioms/evidence notes
- review checklist

This looks good if you want a narrowly scoped migration/review skill rather than a broad plugin.

### 3) Sablier marketplace / agent skills

There are public Sablier skill repos that explicitly list:
- `effect-ts`
- `effect-ts-next`

So there is already a public ecosystem of reusable Effect skills outside OpenAI's own docs.

### 4) PaulRBerg ecosystem

Two relevant repos show up here:
- `PaulRBerg/agent-skills` includes an `effect-ts` skill
- `PaulRBerg/dot-agents` lists external skill sources and explicitly mentions `sablier-labs/agent-skills` with `effect-ts`

This is useful mainly as a discovery/install ecosystem.

### 5) Skills marketplaces / indexes

I found multiple public indexes and marketplaces surfacing Effect-related skills, including:
- `ComposioHQ/awesome-codex-skills`
- `VoltAgent/awesome-agent-skills`
- LobeHub skill pages for `effect-v4`, `effect-ts`, and `Effect-TS Expert`

I would use these for discovery, but I would trust the underlying GitHub repos more than the marketplace card itself.

## What I would personally put in your markdown file

If the goal is a repo-local knowledge file instead of a Codex skill, I would make the doc contain these sections:

1. **Current state of Effect v4**
   - beta status
   - link to official beta post
   - link to official migration guides

2. **Bun setup**
   - `bun init`
   - `bun add effect@beta`
   - `bunx create-effect-app@latest`
   - `bun add -D @effect/language-service @effect/eslint-plugin vitest @effect/vitest`
   - `bun add @effect/platform @effect/platform-bun`

3. **Preferred references in order**
   - `effect-smol`
   - migration docs
   - `effect-solutions`
   - `Effect-TS/examples`
   - `effect-workshop`

4. **Agent/AI references**
   - `joelhooks/effectts-skills`
   - `agustif/effect-v4-skill`
   - Sablier effect skills
   - discovery indexes

5. **Rules for your own repo**
   - prefer v4-native imports
   - check `effect-smol` before trusting older blog posts
   - prefer `@effect/vitest` + `it.effect`
   - for Bun platform APIs, prefer `@effect/platform-bun`
   - use Effect LSP to catch outdated/renamed APIs during migration

## My recommendation

If you want the highest signal-to-noise stack for **Bun + Effect v4** today, I would do this:

```bash
bunx create-effect-app@latest
bun add effect@beta
bun add @effect/platform @effect/platform-bun
bun add -D @effect/language-service @effect/eslint-plugin vitest @effect/vitest
```

Then keep these open side-by-side:
- `effect-smol`
- `MIGRATION.md`
- `migration/schema.md`
- `effect-solutions`
- `joelhooks/effectts-skills`

That gives you:
- official v4 truth
- migration coverage
- Bun support
- editor assistance
- tests
- real-world community patterns
- at least one public skill/plugin repo that already speaks v4

## Source links

### Official Effect docs / repos
- Effect v4 beta post: https://effect.website/blog/releases/effect/40-beta/
- Effect installation docs: https://effect.website/docs/getting-started/installation/
- Effect devtools / LSP docs: https://effect.website/docs/getting-started/devtools/
- Effect platform introduction: https://effect.website/docs/platform/introduction/
- Effect command docs: https://effect.website/docs/platform/command/
- Effect Schema introduction: https://effect.website/docs/schema/introduction/
- Effect Schema getting started: https://effect.website/docs/schema/getting-started/
- Effect Schema transformations: https://effect.website/docs/schema/transformations/
- create-effect-app release post: https://effect.website/blog/releases/create-effect-app/
- Official examples repo: https://github.com/Effect-TS/examples
- create-effect-app README in examples repo: https://github.com/Effect-TS/examples/blob/main/packages/create-effect-app/README.md
- Effect main repo: https://github.com/Effect-TS/effect
- Effect `AGENTS.md`: https://github.com/Effect-TS/effect/blob/main/AGENTS.md
- Effect v4 repo (`effect-smol`): https://github.com/Effect-TS/effect-smol
- v3 -> v4 migration guide: https://github.com/Effect-TS/effect-smol/blob/main/MIGRATION.md
- Schema migration guide: https://github.com/Effect-TS/effect-smol/blob/main/migration/schema.md

### Official / first-party tooling
- Effect language service repo: https://github.com/Effect-TS/language-service
- Effect language service releases: https://github.com/Effect-TS/language-service/releases
- Effect ESLint plugin repo: https://github.com/Effect-TS/eslint-plugin
- `@effect/language-service` on npm: https://www.npmjs.com/package/@effect/language-service
- `@effect/eslint-plugin` on npm: https://www.npmjs.com/package/@effect/eslint-plugin
- `@effect/vitest` on npm: https://www.npmjs.com/package/@effect/vitest
- `@effect/platform-bun` on npm: https://www.npmjs.com/package/@effect/platform-bun

### Bun docs
- Bun install docs: https://bun.com/docs/installation
- Bun package manager install docs: https://bun.com/docs/pm/cli/install

### Community learning / examples
- effect-solutions: https://github.com/kitlangton/effect-solutions
- effect.solutions website: https://effect.solutions
- Ethan Niser effect-workshop: https://github.com/ethanniser/effect-workshop
- Antoine Coulon effect-introduction: https://github.com/antoine-coulon/effect-introduction
- awesome-effect-ts: https://github.com/tcmlabs/awesome-effect-ts

### Community skills / plugins / discovery
- joelhooks/effectts-skills: https://github.com/joelhooks/effectts-skills
- agustif/effect-v4-skill: https://github.com/agustif/effect-v4-skill
- Sablier plugin marketplace: https://github.com/sablier-labs/plugin-marketplace
- PaulRBerg agent-skills: https://github.com/PaulRBerg/agent-skills
- PaulRBerg dot-agents: https://github.com/PaulRBerg/dot-agents
- Composio awesome codex skills: https://github.com/ComposioHQ/awesome-codex-skills
- VoltAgent awesome agent skills: https://github.com/VoltAgent/awesome-agent-skills
- LobeHub Effect v4 skill listing: https://lobehub.com/skills/teeverc-effect-ts-effect-v4
- LobeHub Effect-TS skill listing: https://lobehub.com/skills/terminalskills-skills-effect-ts
- LobeHub Effect-TS Expert listing: https://lobehub.com/skills/ojowwalker77-claude-matrix-effect-ts
