# Historical development records

Current guidance lives in the [PRD](PRD.md), [guide](rig-guide.md), and
[cutover readiness](rig-cutover-readiness.md). Completed predecessor plans and
Effect notes were removed from the working tree to keep obsolete instructions
out of current development. Their original contents remain in Git at
`7134a20361bd37d662ae67b842b2aeb36e403fdf`.

| Record | Why it left the working tree |
|---|---|
| [TODO.md](https://github.com/b-relay/rig/blob/7134a20361bd37d662ae67b842b2aeb36e403fdf/TODO.md) | Superseded rewrite checklist; completion evidence lives in cutover readiness. |
| [docs/effect-v4-help-notes.md](https://github.com/b-relay/rig/blob/7134a20361bd37d662ae67b842b2aeb36e403fdf/docs/effect-v4-help-notes.md) | Effect API notes; Effect is no longer a dependency. |
| [docs/prds/cli-provider-cleanup.md](https://github.com/b-relay/rig/blob/7134a20361bd37d662ae67b842b2aeb36e403fdf/docs/prds/cli-provider-cleanup.md) | Completed CLI/provider cleanup specification (#54–62). |
| [plans/cli-provider-cleanup-issues.md](https://github.com/b-relay/rig/blob/7134a20361bd37d662ae67b842b2aeb36e403fdf/plans/cli-provider-cleanup-issues.md) | Completed issue drafts (#55–62). |
| [plans/cli-provider-cleanup.md](https://github.com/b-relay/rig/blob/7134a20361bd37d662ae67b842b2aeb36e403fdf/plans/cli-provider-cleanup.md) | Completed CLI/provider cleanup execution. |
| [plans/pantry-cutover-rehearsal.md](https://github.com/b-relay/rig/blob/7134a20361bd37d662ae67b842b2aeb36e403fdf/plans/pantry-cutover-rehearsal.md) | May rehearsal; September rollout evidence supersedes its active-plan status. |
| [plans/rig-issue-execution.md](https://github.com/b-relay/rig/blob/7134a20361bd37d662ae67b842b2aeb36e403fdf/plans/rig-issue-execution.md) | Completed original issue execution (#3–22). |
| [plans/rig-runtime-authority.md](https://github.com/b-relay/rig/blob/7134a20361bd37d662ae67b842b2aeb36e403fdf/plans/rig-runtime-authority.md) | Completed runtime-authority plan (#32–47). |
| [plans/rig-stage.md](https://github.com/b-relay/rig/blob/7134a20361bd37d662ae67b842b2aeb36e403fdf/plans/rig-stage.md) | Completed second-stage plan (#16–22). |
| [plans/rig.md](https://github.com/b-relay/rig/blob/7134a20361bd37d662ae67b842b2aeb36e403fdf/plans/rig.md) | Completed original implementation plan. |

Recover any record locally with `git show 7134a203:<path>`.
The [pre-TypeScript cutover record](rig-cutover-readiness-pre-typescript.md)
and September [review evidence](reviews/2026-09-09-rewrite-milestones.md) remain
because they explain state preservation and live rollout decisions.
