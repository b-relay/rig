# Repository cleanup review

Reviewed the working tree based on `7134a20361bd37d662ae67b842b2aeb36e403fdf`.
The baseline was clean, with 158 tracked files. This review inventories the
whole repository and examines source boundaries by module; it is not a claim
that every function has been independently proved correct.

## Changes and reasons

- Removed ten superseded documents, including the contradictory TODO checklist,
  completed predecessor plans, and Effect API notes. Their original contents
  are recoverable through the exact-commit links in [history](../history.md).
- Reduced README to usage, development, module navigation, and authoritative
  documentation links. Corrected the guide's stale pending-rollout statement
  using the existing release evidence, without claiming fresh Host validation.
- Consolidated config source reading and safe error annotation, recorded port
  mapping, atomic install-receipt writes, Caddy marker interpretation/reload
  commands, and exact Git Commit validation.
- Removed unused `SelectedProject`, `RuntimeFiles.exists`, artifact-ownership
  `observe`, and a repeated CLI JSON-mode assignment. Repository-wide caller
  searches established these removals; supported commands and formats remain.
- Enabled TypeScript's unused-local and unused-parameter checks permanently.
- Fixed three boundary defects: a hanging health provider could block startup
  forever; an empty daemon command leaked its startup-log handle; the Git source
  store accepted impossible Commit lengths between SHA-1 and SHA-256 widths.

## Coverage and disposition

| Files | Assessment |
|---|---|
| README, TODO, DESIGN, CONTEXT | Trimmed onboarding and removed conflicting completion tracking. Retained accepted domain/architecture contracts; shortening those requires reconciling requirements, not deleting repeated words. |
| `docs/PRD.md`, `docs/rig-guide.md`, `docs/agents/*` | Kept current requirements, command reference, and repository conventions. Repaired links to removed predecessors. |
| `plans/*`, Effect notes, historical PRD | Removed completed predecessors; kept the current observability/rewrite plans and this cleanup plan. History index preserves provenance. |
| `docs/reviews/*`, cutover records, preservation policy | Retained operational evidence: adoption, source identity, rollback, and the deliberate Pantry resume exception are still relevant. |
| `src/config/*` | Source reads repeated decoding/error policy; consolidated it. Kept restricted YAML, comment-safe edits, revision checks, and backup verification as distinct responsibilities. |
| `src/runtime/*`, `src/domain/*` | Consolidated port/Commit policy and fixed readiness settlement. Retained serialized mutation and recorded deployment recovery. Remaining policy-snapshot work is below. |
| `src/adapters/*` | Reused existing atomic writing and removed unused capabilities. Kept effect checkpoints, external-edit detection, installation ownership, and legacy log support. |
| `src/providers/*` | Consolidated Caddy parsing/reload policy and Git validation. Process-identity and crash-recovery code has behavioral justification; file length alone is not a removal reason. |
| `src/daemon/*`, `src/git/*` | Fixed resource acquisition ordering and shared Commit checks. Retained transport validation, Git destination selection, and registration compensation. |
| `src/cli/*`, `src/diagnostics/*`, entrypoints | Removed redundant assignment. Kept user output, diagnostics, activity, and Target logs separate; diagnostic locking/rotation protects concurrent writers and process death. |
| `tests/*`, colocated tests, fixture | Retained public behavior/integration coverage. The fullstack fixture has an active config-test consumer. Added regressions at existing seams before changing behavior. |
| package/lock/compiler config, `rig.json`, `.gitignore` | Runtime dependencies are used. Kept build/deployment configuration; added unused-code checks. Generated binaries and dependencies are ignored build assets. |
| AGENTS and CLAUDE symlink | Preserved repository instructions and the source-of-truth symlink. Local ignored runtime artifacts were not cleanup candidates. |

## Function-design contracts

The following are the ledger entries that produced changes. Standard library
operations are trusted; retained provider behavior is covered through public
integration tests. Test fixtures own their temporary files and injected state.

| Boundary and caller job | Inputs, outputs, effects, failure and ownership |
|---|---|
| `readDocumentSource`; inspection and editing need one decoded revision | Takes explicit path and validator; reads one file and returns raw bytes plus validated document/revision. Filesystem access belongs to this adapter. `decodeDocument` is pure and covered by YAML/JSON tests. Safe path annotation and read/parse failures now have one owner. The narrower `readDocument` projection deliberately omits raw bytes from ordinary reads. |
| `recordedPorts`; planning, repoint, and doctor need recorded assignments | Borrows read-only components, returns a new map, retains/mutates nothing, performs no I/O. Only managed components contribute entries; optional Convex site ports use the existing `.site` name. Callers own allocation, validation, and conflicts. Ordinary/mixed plans and repoint/doctor preservation are covered at runtime/config seams. |
| `writeInstallReceipt`; installation records completed artifact identity | Takes explicit path and typed receipt, serializes it, then delegates filesystem effects to the existing `atomicFile`. Keeps private directory/file modes, rename publication, temporary cleanup, and propagated failures. The wrapper retains receipt vocabulary and typing; it no longer owns another atomic-write algorithm. |
| `ownedBlock` and `routeMarkers`; route mutation and checkpoints need identical ownership interpretation | Pure text/key operations; return materialized marker/block strings or absence. No borrowed result lifetime or external state. Incomplete/reversed markers keep `ROUTE_CORRUPT`; checkpoint mismatch keeps `ROUTE_CHANGED` precedence. Router owns serialization, validation-before-publication, reload, rollback, and unrelated text. CRLF, missing/corrupt blocks, restore, and later-edit rejection are covered. |
| `awaitReady`; lifecycle must finish readiness or roll back startup | Takes recorded component/Target and only the health capability. Owns deadline timer and cancellation; provider effects remain explicit. Races settlement against expiry, preserving provider failure before deadline and `HEALTH_FAILED` at expiry. Lifecycle retains process/checkpoint rollback. A provider ignoring cancellation can still run in the background; JavaScript cannot forcibly stop arbitrary provider work, but it no longer holds the operation open. |
| `spawnDetached`; daemon installation acquires a process and startup log | Reads explicit admin options and inherited process environment; owns filesystem handle and detached child creation. Validate command before acquiring the handle; `finally` closes every acquired handle. Empty command retains `DAEMON_COMMAND`, now without creating/opening startup.log. Existing install/uninstall tests cover successful children and exit behavior. |
| `isGitCommit`; Git boundaries must agree on exact object identity | Takes a string, returns a boolean with no effects, mutation, or exceptions. Every caller treats invalid values as rejection and retains its own contextual error. Exact lowercase 40/64-character hex widths have one owner. Tests cover real SHA-1 deployments, SHA-256 preflight acceptance, and rejection before publication of 41/63-character results. Historical state schema remains permissive for preserved metadata. |
| `runRigCli`; render each command using its chosen output mode | Removed only a duplicate assignment after the operation ID was acquired. Client, diagnostic, output, interaction, cancellation, and ID effects remain injected; CLI tests continue to cover structured output and failures. |

These bodies now separate reading/validation, policy calculation, and publication
more clearly. No generic framework, alternate runtime, or parallel compatibility
implementation was introduced. Public signatures are unchanged except removal
of unused internal capabilities and the two new pure policy helpers.

## Further work identified

1. **Local reasoning and consistency:** `src/runtime/application.ts:196` and
   `src/runtime/targets.ts:63` independently read Host deployment policy; other
   deployment branches repeat the read. A single command can observe different
   config revisions. Acquire one policy snapshot at the command boundary, then
   pass the needed branch/capacity values into planning. Test with a Host provider
   returning different successive revisions before changing this contract.
2. **Testability and failure control:** `src/daemon/admin.ts:299` owns another
   concrete launchctl runner with unbounded captured output and no deadline.
   Move it behind the existing bounded `CommandRunner`, retaining admin-specific
   errors and adding isolated launchd success/failure/timeout coverage. This
   deserves a separate behavior change rather than a mechanical replacement.
3. **Output consistency:** `src/cli/output.ts:134` and
   `src/cli/terminal-text.ts:3` implement different sanitization policies.
   Ordinary output handles fewer terminal-control forms than prompts. Establish
   the intended whitespace/control policy with CLI-output tests before unifying;
   blindly reusing one helper changes visible log text.
4. **Optional readability:** remote advertisement selection in
   `src/git/remote-helper.ts` and response-error construction in
   `src/daemon/server.ts` could each gain a small pure policy owner. Existing
   validation distinctions and protocol order must survive that extraction.

Do not remove migration merely because live adoption has completed locally.
Daemon composition still calls the adoption guard, and exported migration tools
protect upgrades elsewhere. Stored pending/blocked/committing recovery stages,
ownership manifests, and recorded source uncertainty remain necessary contracts.

## Verification and independent review

- Baseline: 186 tests, 989 assertions; strict typecheck and unused-code checks passed.
- Readiness regression failed at the test watchdog before the fix and completed
  with `HEALTH_FAILED`, cancellation, stopped new processes, and rollback afterward.
- Empty-command and malformed-Commit regressions failed for the expected reasons
  before their fixes. Config parity, Caddy CRLF/corruption, and port-preservation
  characterization passed before and after consolidation.
- Runtime/adapters and provider/daemon/Git reviewers independently reviewed the
  cleanup. Neither found a material regression. Their SHA-256 coverage and Caddy
  error-precedence notes were addressed with tests.
- Final validation: 194 tests, 1,026 assertions, zero failures (54.65 seconds);
  `bun run typecheck` passes with unused-code checks enabled. All three binaries
  build and pass `--help` and `-h`. Relative links in all 27 remaining Markdown
  documents resolve, and `git diff --check` passes.
- Integration required localhost binding outside the sandbox and used temporary
  RIG_ROOTs and provider resources. No live Host rollout was performed.
- Net reduction is approximately 2,800 lines, including new regression tests,
  the history index, and this review. The cleanup is delivered separately from
  the merged TypeScript rewrite; it does not update the installed Host.
