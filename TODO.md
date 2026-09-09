# TODO

## September 9 Rewrite — In Progress

The [execution plan](plans/typescript-rewrite.md) tracks the strict TypeScript,
Bun, and Zod rewrite without Effect TS. Deliver one PR and send its link in
Slack; do not push the implementation directly to `main`.

- [ ] Finish integration and remove the legacy implementation and Effect dependencies.
- [ ] Complete packaging and compiled-binary verification for `rig`, `rigd`, and `git-remote-rig`.
- [ ] Pass full tests, strict typecheck, build, and adversarial lifecycle/deploy tests.
- [ ] Resolve material findings from independent milestone and final reviews.
- [ ] Attach acceptance evidence for every ticket below to the PR.
- [ ] Battle-test before explicitly backing up and upgrading existing Rig Projects.
- [ ] Verify legacy process/route adoption, independent source ownership, preserved data, and rollback evidence for every live cutover.
- [ ] Publish the single PR and send the link in Slack after validation and rollout are complete or report the exact remaining blocker.

## Ticket Coverage Required For This PR

| Issue | Required behavior |
|---|---|
| #64 | Working copy commands run in the actual repository. |
| #65 | Another client can stop daemon-owned processes and verify exit. |
| #66 | Partial-target up preserves already healthy components, including failed-start rollback. |
| #67 | Fresh status and bounded crash recovery reflect observed process state. |
| #68 | Explicit stopped-Project rename/repoint validates identity and ownership conflicts. |
| #69 | Deployment source objects and workspaces remain independent of developer repository Git administration. |
| #70 | Init and Project selection use the canonical configured identity. |
| #71 | Doctor checks never pair success with failure evidence. |
| #72 | Scoped status/lifecycle/deploy JSON preserves domain outcomes without a global output flag. |
| #73 | Lifecycle retains the recorded Branch, Commit, and deployment policy. |

Tests and review evidence exist for these areas; this checklist does not claim
all acceptance work or live rollout is finished. See the
[milestone evidence](docs/reviews/2026-09-09-rewrite-milestones.md) and
[legacy source provenance](docs/reviews/2026-09-09-legacy-source-evidence.md).

Historical #48–#62 cleanup and provider work remains documented in the
[predecessor plan](plans/cli-provider-cleanup.md). Hosted transport, Expert/rigx,
Project deletion, and automatic YAML conversion remain outside this rewrite.
