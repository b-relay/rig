# Issue #245 run notes — release gate of the configuration cutover

Branch `feat/issue-245-release-gate`, PR against `feat/issue-114-config-cutover`.
Every command below ran under a temporary `RIG_ROOT`. No runtime was installed
on the Host, and no live daemon, launchd job, Caddy route or data was touched.
**No live Host was migrated.** The four stages stay distinct:

| Stage              | Status                                                             |
| ------------------ | ------------------------------------------------------------------ |
| Accepted design    | done (`plans/114-config-spec.md`)                                  |
| Source-ready       | done at the revision below                                         |
| Isolated rehearsal | done (`tests/conversion*.test.ts`, `tests/release-matrix.test.ts`) |
| Live deployment    | not done; procedure in `docs/rig-114-rollout.md`                   |

## Tested revision

The tested source is the Commit that merges this ticket's PR into
`feat/issue-114-config-cutover`, published unchanged to `origin/main`. A file
cannot contain the hash of the tree it is part of, so the Commit and its
`git rev-parse HEAD^{tree}` are recorded in the closing comment of #245 and in
the #114 summary. The commands below ran on exactly that tree; the last change
before them was to source, the later ones to this file only.

## What changed in this ticket

- **`tests/release-matrix.test.ts`**, the public matrix, through the real CLI
  and a real `rigd` with owned processes:
  1. one Service, default names: `config`, Doctor, `deploy --no-up`, `up`,
     `restart`, `status`, `logs` (running and stopped), `down` twice, a
     generated Preview; Preview `down` keeps data and logs, Preview `--destroy`
     removes its own storage and nothing of the Stable Target; `--destroy` on
     the Working copy and the Stable Target is refused.
  2. Tool-only, renamed Targets (`devbox`, `prod`): plain command for the
     Stable Target, `<tool>-<target>` for the Working copy and a generated
     Preview; the default names stop being selectors; the role still protects
     the renamed Targets; destroying the Preview removes only its command;
     Doctor and `recipe diff`.
  3. Services and Tools, renamed: `git push rig main` reaches the renamed
     Stable Target; fixture cleanup stops a renamed Working copy and a
     generated Preview it was never told about.
  4. Portability: the same application started by Rig and by hand with the same
     arguments and one environment variable, no Rig variable inherited, gives
     the same answers.
- **Fixture cleanup discovers what the root records** (`tests/support/rig-fixture.ts`):
  it used to stop `local` and `live` of `demo` only. Run against the old
  fixture, matrix test 3 fails and leaves a process behind, which is the gap the
  ticket names. `tests/full-project-e2e.test.ts` and `tests/support/legacy-root.ts`
  lost their hand-written lists.
- **Hook execution removed from the runtime.** After #244 no plan can hold a
  hook (the config schema refuses them, the state schema strips them, the
  conversion maps or blocks each one), so `TargetEffects.hook`, the hook calls in
  `up`/`down`/`restart`, `STOP_HOOKS`, the hook fields of the plan types and
  their tests are gone. The refusal path (`LEGACY_KEYS` in `src/config/schema.ts`)
  and everything under `src/conversion/` stay.
- Removed `fixtures/rig-projects/fullstack-basic/rig.json` (old format, no
  reference anywhere).
- `docs/rig-114-rollout.md`, the Host runbook; status lines of the spec, the
  plan, the interview record and the three examples; guide links the runbook and
  no longer describes stop hooks.

## Matrix coverage by place

| Behavior                                           | Where                                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| config, resolve                                    | matrix 1; `tests/config-examples-e2e.test.ts` (the three `plans/examples` files)                                |
| deploy, no-up deploy, unchanged, force             | matrix 1–3; `tests/build-preparation-e2e.test.ts`                                                               |
| up, restart, down, repeated down                   | matrix 1–2                                                                                                      |
| Preview down/destroy, role protection after rename | matrix 1–2; `src/cli/cli.test.ts`                                                                               |
| logs, status, Doctor, recipe                       | matrix 1–3; `tests/recipes.test.ts`                                                                             |
| help, `-h` for every subcommand                    | `src/cli/cli.test.ts`, `src/cli/rigd.test.ts`, `tests/conversion-plan.test.ts`; compiled binaries checked below |
| Production-branch push to a renamed Stable Target  | matrix 3; `tests/build-preparation-e2e.test.ts`                                                                 |
| Tool aliases                                       | matrix 2–3                                                                                                      |
| conversion and rollback with data sentinels        | `tests/conversion.test.ts`, `tests/conversion-apply.test.ts`                                                    |

The `plans/examples` files use Go and Postgres and are validated, not started;
the matrix uses Bun programs of the same three shapes.

## Supervisors

- Child (capture) supervisor: every e2e test above owns real processes under it.
- launchd: `tests/providers-launchd.test.ts` runs unguarded on darwin against
  the real user launchd domain with unique `test.rig.<uuid>` labels, booted out
  in `finally`; 5 pass, and `launchctl list` shows no `test.rig` label
  afterwards. **Gap:** no test drives the whole CLI with a Host configured for
  the launchd supervisor. The missing prerequisite is a fixture that writes a
  Host `config.yaml` selecting launchd and a label namespace that cannot collide
  with the operator's; it belongs with the first live rollout rehearsal on a
  spare account, and the runbook's step 7 is the check until then.

## Commands and results

| Command                                                                                                                                                                                       | Result                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `bun run typecheck` (source and tests)                                                                                                                                                        | clean                                                        |
| `bun run build`                                                                                                                                                                               | `rig`, `rigd`, `git-remote-rig` built                        |
| `bun test tests/release-matrix.test.ts tests/full-project-e2e.test.ts tests/conversion.test.ts`                                                                                               | 7 pass, 0 fail                                               |
| `bun test tests/providers-launchd.test.ts`                                                                                                                                                    | 5 pass, 0 fail; no `test.rig` label left in `launchctl list` |
| `bun test` (full suite)                                                                                                                                                                       | 809 pass, 0 fail, 84 files                                   |
| `--help` and `-h` on the compiled `./rig` (every subcommand, including `recipe list/generate/diff`), `./rigd`, `./git-remote-rig`, and `bun run cutover`, under an empty temporary `RIG_ROOT` | 46 invocations, all print usage, the root stays empty        |
| leaked test processes after the suite (`ps` for temporary roots)                                                                                                                              | none                                                         |

## What the rehearsal does not prove

Listed in `docs/rig-114-rollout.md` ("What the rehearsal does not prove"): this
Host's unknown state fields, its launchd domain, Caddy, TLS and DNS, the human
hook classification, stale pid records, launchd-mode old daemons, and
application-level compatibility of Postgres/Convex data under recipe Services.

## Host-specific inputs that remain

The Projects and Targets on the Host and their permitted downtime; one decision
per saved hook; the values of env files that live inside repositories; the
existing Postgres/Convex data directories; a place for the independent backup.

## Inherited debt (recorded, not changed)

The conversion strips only hooks, Commit env files and build fields. A converted
saved plan can still carry these retired fields, so their runtime paths are
reachable and were kept: `daemon.keepAlive`, `installTimeout`, `sitePort`,
`installName`, persistent and `uses` Components, `preparedComponents`. They go
away when no converted Target from before the cutover remains, or when the
converter learns to refuse them.
**`src/migration/` is kept deliberately.** Apart from `adoption.ts` (the guard
`rigd` runs at startup) it is used by tests only. It is not a reader on any
normal path and not part of #114: it is the explicit metadata migration of the
earlier TypeScript rewrite, with no command that reaches it, and it writes the
`runtime/legacy-adoption.json` that the adoption guard still enforces. #245
grants no deletion scope beyond the #114 scaffolding, so removing it is listed
in `docs/reviews/2026-09-16-deferred-items.md` for its own decision.

## Review

Codex (Astra, high) was unavailable: usage limit until 2026-09-24. By the user's
choice the single reviewer of this PR was a Claude Opus subagent, briefed for
both the repository standards (function contracts) and the ticket and spec, on
the final integrated revision.

Round 1: no blocker. The reviewer confirmed the hook removal (no reachable path
relied on `STOP_HOOKS` or the pre-stop observation), that the daemon itself
refuses to destroy a Working copy or Stable Target (`DESTROY_TARGET`), every
runbook command and flag, secret safety of the conversion, and reran the matrix.
Five should-fix findings:

1. The spec claimed a full implementation while `services.<name>.workdir`, a
   per-Service `supervisor` and the Host-wide `supervisor` default are not
   runnable. Fixed: the spec status and the guide's "Not yet runnable" say so.
2. The `supervisor` schema description promised the Host/Service override
   chain. Fixed.
3. The README sent Host upgrades to the September TypeScript cutover record,
   which still described JSON compatibility in the present tense. Fixed: the
   README points at the runbook and the record is marked as history.
4. `src/migration/` is tests-only apart from `adoption.ts`. Not deleted; see
   "Inherited debt" for why, and the deferred-items register.
5. The deferred-items row for #194 still named `STOP_HOOKS`. Closed.
