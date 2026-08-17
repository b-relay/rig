# Issue tracker: GitHub

Issues, specs, decision maps, and implementation tickets for this repo live as
GitHub Issues on `b-relay/rig`. Use the `gh` CLI for all operations. This
file overrides the global Linear default in `~/.codex/docs/agents/issue-tracker.md`.

Legacy Linear identifiers (`B-123`) still appear in commit messages, PR titles,
and code comments. Migrated issues carry a `Migrated from B-123` line at the
top of their body; search with `gh issue list --search "B-123 in:body"`.

The Linear "Rig" project was copied across on 2026-08-16 by pantry's temporary
`scripts/migrate-linear-to-github.ts` (comments folded into each body as an
"Updates from Linear" section). Nothing Linear-specific remains to run here.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..." --label ...`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close as done**: `gh issue close <number> --reason completed --comment "..."`
- **Close as won't do / duplicate**: `gh issue close <number> --reason "not planned" --comment "..."` (name the surviving issue for duplicates, and add the `duplicate` label).

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Workflow states

GitHub Issues have only open/closed, so the workflow states the skills refer to
(`Backlog`, `Todo`, `Ready`, `In Progress`, `In Review`, `Done`, `Canceled`,
`Duplicate`) are represented like this. An issue carries **at most one** of the
state labels; moving state means removing the old one and adding the new one.

| Workflow state | GitHub representation |
| --- | --- |
| Backlog (awaiting triage) | open, `needs-triage` |
| Todo (accepted, not yet specified) | open, no state label |
| Blocked / waiting on info | open, `needs-info` (waiting on a person) or `ready-for-human` (needs a human action) |
| Ready (fully specified, agent may take it) | open, `ready-for-agent`, no assignee |
| In Progress | open, `in-progress`, assigned |
| In Review | open, `in-review`, linked PR open |
| Done | closed, reason `completed` |
| Canceled | closed, reason `not planned`, `wontfix` |
| Duplicate | closed, reason `not planned`, `duplicate` |

Type labels (`bug`, `enhancement`, `documentation`) may be combined freely with
a state label.

Blocked-ness is not a label: use GitHub's native issue dependencies (below). A
ticket is blocked while `issue_dependencies_summary.blocked_by > 0`.

## Linking PRs to issues

Rig's git workflow pushes directly to `main`, so most work has no PR. Put
`Closes #<n>` (or `Fixes #<n>`) in the commit message so GitHub links the commit
to the issue and closes it when it lands on `main`. When a PR is opened, put the
same line in the PR body. `in-review` therefore only applies to work that does
go through a PR.

## Sub-issues and dependencies

- **Parent/child**: GitHub sub-issues. Add a child with
  `gh api --method POST repos/b-relay/rig/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`,
  where `<child-db-id>` is the child's numeric **database id**
  (`gh api repos/b-relay/rig/issues/<n> --jq .id`, _not_ the `#number` or `node_id`).
  List children with `gh api repos/b-relay/rig/issues/<parent>/sub_issues`.
- **Blocking**: GitHub's native issue dependencies. Add an edge with
  `gh api --method POST repos/b-relay/rig/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
  Read with `gh api repos/b-relay/rig/issues/<n> --jq .issue_dependencies_summary`.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `b-relay/rig`. Apply a type label and, unless told
otherwise, the state label the skill names (`to-tickets` uses `ready-for-agent`).

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## When a skill says "move the ticket to Ready / In Progress / In Review / Done"

Swap the state label per the table above; for Done, close with `--reason completed`.
The supervisor claims a ticket with `gh issue edit <n> --add-assignee @me` before
moving it to `in-progress`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (see above). Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: native issue dependencies (see above). A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
