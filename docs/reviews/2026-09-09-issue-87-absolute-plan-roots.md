# Issue 87: absolute Runtime plan roots

## Decision and interface

Before: `resolveTargetPlan(input): TargetPlan` admitted relative workspace and
Persistent storage roots; `path.resolve` could silently consult process cwd.
After: the same interface validates both acquired root strings before parsing
Project policy or constructing plan properties. Relative/empty roots throw
`ConfigError` (`relative_root`), identifying the field and explaining that the
caller must supply absolute roots. Config-relative paths remain portable.

Compared local validation against an opaque AbsolutePath value propagated through
discovery, runtime records, and adapters. Chose the local guard: one calculation
boundary owns the prerequisite, no format migration is needed, and a type wrapper
would broaden this narrow fix without proving filesystem existence or ownership.
The input type remains string-based and explicitly says validation occurs here;
it does not claim construction has already established an invariant.

## Caller and producer inventory

- `src/adapters/project-documents.ts` exposes this resolver through ProjectDocuments.
- `src/runtime/targets.ts:planTarget` uses registered `project.repoPath` for local,
  and `sources.prepare().workspacePath` for Stable/Preview. Discovery in
  `src/config/documents.ts:discoverProject` uses `realpath`; registration preserves
  that canonical identity. `src/cli/entry-environment.ts:rigRoot` resolves ambient
  RIG_ROOT/home at the entrypoint; daemon composition passes that absolute root.
  Target data/revision roots are joined beneath it. The Git source store returns
  the absolute requested destination unchanged. Existing Persistent roots are
  reused from the recorded plan.
- `src/runtime/registration.ts:updateRegistration` rediscovers a moved local
  repository with `realpath`, combines it with recorded data root and ports, and
  resolves before publishing registration changes.
- `src/runtime/doctor.ts:inspectProject` re-resolves recorded workspace/data roots
  for comparison. Invalid historical roots now produce a config finding instead
  of cwd-dependent comparison; no record is rewritten.
- Direct programmatic calls in `tests/config.test.ts` and
  `tests/runtime-review-regressions.test.ts` supply explicit absolute fixtures.
  Runtime application/regression harnesses expose the resolver through the same
  documents interface. Arbitrary programmatic strings remain runtime-checked.

All production resolve calls were re-read after the change. No acquisition,
source preparation, port reservation, or persisted root ownership moved.

## Function contract ledger

`resolveTargetPlan`: caller job is to calculate runtime policy from validated
Project configuration, Target identity, caller-acquired roots and assigned ports.
Inputs are the existing request object; result is a complete materialized plan.
No caller input mutation, filesystem access, current-root read, port allocation,
logging, or retained state. Local intermediate maps/arrays are owned by the call.
Both roots must be absolute before any policy calculation; first invalid field
wins deterministically, workspace before data. Existing invalid config, port,
interpolation and binding failures remain ConfigError; callers own display and
operation failure policy. There is no partial result on rejection.

Direct callees: `isAbsolute` and `join` are trusted lexical path operations;
`resolve` is trusted to avoid cwd given the checked absolute workspace fallback.
`parseProjectConfig` is the existing Zod validation boundary, covered by config
checks; property/component/hook interpolation and dependency ordering are existing
pure helpers covered through complete public plans. ConfigError owns structured
failure construction. Object operations mutate only local calculation objects.
Inherited debt: accepted absolute paths do not prove existence, symlink safety,
or ownership. Runtime state schema remains string-based; this guard rejects bad
historical roots when resolving rather than migrating them. Caller orchestration
still owns source and reservation effects before invoking calculation; this fix
makes no wider transactional claim.

Steps 1–8: real caller inputs and complete result retained; ambient fallback
eliminated by local prerequisite; request shape remains exact; tagged errors retain
field identity; root validation precedes peer calculation stages; one owner of the
new invariant; public tests cover rejection and supported composition. Empty roots
reject; empty component plans remain supported; no mutation/partial-effect channel
exists to assert. Existing nested resolver mechanics are unchanged.

## Verification

Red: isolated `bun test tests/config.test.ts` after offline dependency install:
18 pass, 4 fail, 66 assertions. Each new root test received unknown_interpolation
instead of relative_root, proving calculation started before rejection.
Green guard: 22 pass, 0 fail, 66 assertions.

Final focused command (isolated RIG_ROOT=/tmp/rig-87-focused/.rig, authorized
process/localhost access):

```
bun test tests/config.test.ts tests/runtime-application.test.ts tests/runtime-review-regressions.test.ts tests/deployment-e2e.test.ts tests/deployment-effects.test.ts tests/runtime-lifecycle.test.ts
```

84 pass, 0 fail, 355 assertions. Complete plans compare equal in two child
processes with different cwd, including Unicode/spaces, installed entrypoint,
Target/component envfiles, SQLite relative/default paths, Postgres storage,
assigned ports, forward interpolation, and dependency order. Existing local,
Stable, Preview, repoint, recorded-policy and Persistent retention tests pass.
One intermediate fixture attempt used unsupported installed `dependsOn`; corrected
the fixture to exercise supported managed dependency order before the final run.

`RIG_ROOT=/tmp/rig-87-typecheck/.rig bun run typecheck` passed. Full suite, final
compiled entrypoint gates, and independent reviews belong to the supervisor.
No live launchd/Caddy or user deployment was changed.
