# September 10 rollout and reassessment

The installed Rig release and active daemon are based on
`83496f8dafde3909a7a7121ef496aeae4dacd2ef`, which incorporates the 19 completed
architecture and reliability tickets. Its merge gate passed 355 tests, strict
TypeScript, three compiled binaries, and both help flags for each executable.
The rollout rebuilt and typechecked the same source before installation.

## Upgrade and preservation

The operator copied and byte-verified the prior binaries, runtime metadata,
artifact ownership records, daemon installation definition, and saved routing
and job definitions before deployment. The previous immutable daemon release
remains available. Exact paths, hashes, process evidence, and command output are
in the private `rollout-20260910-83496f8` backup and operator record.

The public `rig deploy live main --project rig` command installed the reviewed
Commit. All three installed binaries matched their built Deployment artifacts.
The operator then staged an immutable copy, unloaded only the verified daemon
launchd job, and installed the daemon from that new immutable release. The old
daemon exited and the new process reported a different identity and the expected
executable path. Daemon health and Rig's Doctor checks passed.

Other recorded Targets and Project registrations were preserved. Pantry's old
capture wrappers continued running, and sampled backend, web, and public-route
HTTP requests returned 200. Its saved production-resume exception was retained;
no Pantry source deployment, startup hook, database migration, or application
restart was performed.

**Compatibility limit:** those existing Pantry wrappers predate the fresh
application-ownership evidence introduced by #79. The new daemon therefore
reports their state as `unknown` instead of treating wrapper liveness as proof
of application ownership. HTTP samples establish reachability, not the missing
ownership evidence or continuous availability. A deliberate restart under the
recorded safe policy is required to replace those wrappers; this rollout leaves
that application transition separate.

## Disposable verification

Two distinct scopes were exercised:

- A disposable Preview on the real Host deployed and removed installed-tool
  artifacts. The initial fixture expected Branch configuration to replace the
  registered Project configuration; the first Status assertion caught that
  incorrect assumption. Cleanup selected the Preview by its explicit deployment
  name. Existing live Target and Project records matched the pre-check snapshot
  afterward.
- The newly installed binaries then ran a real daemon and launchd-managed test
  application in an isolated `RIG_ROOT`. This let the fixture register its own
  configuration without changing a real Project's intent.

The managed Preview checks passed:

1. Deploy returned the expected Commit; Status reported healthy application
   evidence, and its localhost HTTP endpoint returned the expected body.
2. Normal Logs retained stdout and stderr. Follow emitted each marker once and
   exited successfully within the two-second verification bound after SIGTERM.
3. Ordinary `down` preserved the fixture's data. Repeated `down` returned
   `unchanged`, and its pre-stop hook had run exactly once.
4. Restarting the stopped Preview and then using `--destroy` removed its owned
   data/source root and inventory. No additional confirmation was required.
5. No listening socket remained. A plain socket bind initially encountered
   post-close TCP state; an independent listener check and address-reuse bind
   confirmed that the application had released the port.
6. The isolated daemon was uninstalled after Target cleanup.

These are real-process checks using installed binaries, with managed application
data isolated from production. They do not constitute a production application
restart, database-integrity audit, hostile-filesystem test, or continuous uptime
measurement.

An independent read-only verifier passed the scoped rollout checks. It verified
the actual loaded daemon executable, installation definition, binary/artifact/
ownership/receipt hashes, rollback manifest, all seven retained Project records,
both non-Rig Target records, sampled Pantry reachability, and absence of the
disposable jobs, processes, listeners, and Target roots. Its detailed report is
retained with the private operator evidence. Transient data and hook assertions
were inspected from the exercise record rather than replayed after destruction.

## Function honesty reassessment

The independent [Codex tree](2026-09-10-function-honesty-tree-codex.md) and
[Fable 5.1 tree](2026-09-10-function-honesty-tree-fable.md) assess the same source
Commit. They distinguish intended effect owners from hidden dependencies and
identify exact first-crossing edges. Their source-review conclusions and
coverage limits are separate from the operational evidence above.

The trees confirm that the accepted hidden-clock, relative-root, Git discovery,
process-inspection, connection-acquisition, and Status-contract changes landed.
The most useful remaining work concerns validated non-Status replies, truthful
error distinctions and diagnostic results, one config snapshot per Doctor
report, and clearly scoped process timing dependencies. Adapter-local platform
defaults are a design discussion rather than a jointly established defect:
function-design permits a documented adapter to own an outside effect.

Both initial reports were completed independently. Fable's report then received
a source-based factual correction pass; this preserves its authorship and
independent assessment while correcting interface and call-order claims. CLI
transcript metadata confirmed the requested `claude-fable-5-1` model.
