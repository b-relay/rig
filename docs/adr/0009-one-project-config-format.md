---
status: accepted
---

# rig.yaml has one format again

This supersedes [ADR 0008](0008-versioned-project-config-formats.md). Rig is being cut down to what its one operator uses. Every Project's rig.yaml is written in the undeclared format that ADR 0008 called `rig/v1`. No Project used `rig/v2`, its `health` block, or the ongoing health checks that block drove. Reading two formats cost a list of format steps, a schema per format, a parser that moved older files forward, deprecation lines in every reply, `rig config upgrade`, and the config editor's per-format spelling.

- Rig reads one format: a Service's readiness is `ready` (an http(s) URL or a command) and `ready_timeout`, in Services and in every role's Service patch. There is no `format` key, and `schemas/rig.schema.json` is the only Project schema.
- A rig.yaml that still has `format` or a `health` block is refused, each with a hint saying what to do: delete `format`; write `health.check` as `ready` and `health.start_timeout` as `ready_timeout`. Ongoing health checks (`interval`, `failures`, `timeout`, `retry_for`, `on_failure`) were removed and have no replacement.
- `rig config upgrade` and the deprecation lines are gone. ADR 0001's YAML-only rule stands, now with no migration command.
- A recorded plan keeps its shape: a Service's resolved check is still its plan's `health` and `readyTimeout`. A recorded plan or run that names an ongoing health check is cleaned when state is read, so state from before this change loads.

Bringing a second format back needs a new decision. Until then, a config change that would break existing files is made as a direct edit to the files, not as a format version.
