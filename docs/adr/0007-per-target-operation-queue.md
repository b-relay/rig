---
status: accepted
---

# Serialize operations per Target, not per Host

For [#277](https://github.com/b-relay/rig/issues/277), the maintainer decided that Projects are independent. `rigd` had run one mutation at a time across the whole Host, and its automatic-restart passes used the same queue, so a Service that legitimately needs minutes to stop ([#278](https://github.com/b-relay/rig/issues/278)) would have frozen every other Project's lifecycle and every automatic restart for that long.

Operations now wait for each other only when they work on the same thing. Each one takes, all at once, the scopes it needs from a hierarchy: the whole Host, one Project (every Target it has), or one Target (the Working copy and Stable Target keyed by role, a Preview by its name). Scopes conflict when one contains the other. Requests are granted first come, first served, and a request never overtakes an earlier one it conflicts with, so a Project-wide operation is not starved by a stream of Target operations. Because every scope is taken at once and nothing is taken while one is held, operations never wait on each other in a cycle.

- `up`, `down`, `restart`, `deploy`, `git push` and Preview `destroy` take their Target. A deploy of a new Preview at the Preview limit also takes the Previews it will replace.
- `rename`, `repoint`, `forget`, `init` of a registered Project and config edits take their Project; `init` of a new Project and `rename` also take the name being registered.
- `rigd uninstall`'s preparation and the start of the daemon's first pass take the Host. That pass then hands each Target its own scope in the same step, before anything queued behind it runs, and re-stops or supervises the Targets side by side.
- Automatic restart passes take each Target only when it is free and skip it otherwise: the operation holding it owns it, and the next pass looks again. A pass waits a bounded time for the Targets it works on, then leaves slow work (a restart waiting for readiness, a stop waiting for an exit) running under that Target's scope, so the next pass still reaches every other Target.

Resources the Targets share are claimed in short critical sections that never span a wait for a process to exit or a build: the state file (every write is one serialized read-modify-write of the current file, touching only the writer's own records), the ports chosen for `auto` (chosen one at a time against recorded Targets and the ports running operations have claimed but not recorded yet), the Preview limit (a new Preview is counted, and its slot claimed, with nothing awaited in between), the Caddy route file and each installed executable's destination. A claim lasts until its operation ends, when the state file records the result or the operation failed.

While an operation waits for a Target's Services to exit, the Target is `stopping`: `rig status` shows it, and a command on that Target waits and prints what it waits for. How long the stop may take and the SIGKILL deadline belong to #278, which adds them to the same phase.

`rigd` shutdown still detaches Services and never stops them. Commands already running are given the drain; any still waiting for their Target is refused as `DAEMON_DRAINING`. A stop that a shutdown or a crash interrupts is recovered by the next daemon, as any other interrupted operation is: the Target was recorded as meant to be stopped before its stop began, so the next daemon's first pass stops it again.

We rejected the smaller fallback of waiting for exits outside the Host-wide queue while supervision skips Targets mid-stop. It would have kept builds and readiness waits Host-wide and left a second kind of lock for stops alone.
