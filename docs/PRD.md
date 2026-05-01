# rig PRD

## Status

This PRD is the active product contract for the current `rig` CLI. The
replacement runway has already completed: legacy implementation code was
removed, the main entrypoint is `rig`, and remaining work is post-cutover
product/provider hardening.

## Problem Statement

`rig` is a local Mac deployment manager for humans and AI agents. The current
product direction is to make one-machine app operations feel obvious: run the
current repo, inspect runtime state, deploy a ref, route traffic, and recover
from local-machine drift without carrying a large operational checklist.

The hard parts are provider safety and runtime authority. Real providers can
touch launchd, Caddy, git worktrees, process trees, logs, and local state, so
the shipped binary must be testable under isolated state and swappable provider
profiles. Runtime truth must come from `rigd`, not from each command
reconstructing state differently.

The result is a system that works, but asks users and agents to carry too much operational context:

- Which project am I targeting?
- Is this a long-running runtime or an installed executable?
- Is this a dev environment, a prod environment, a release, a workspace, or a version?
- Can I safely deploy this branch without manually creating semver tags?
- Can the CLI and future web UI trust the same runtime state?
- Can tests use the real binary without touching real machine integrations?

`rig` should collapse those decisions into one obvious repo-first,
lifecycle-first workflow while preserving the strict architectural boundary that
keeps external concerns testable and swappable.

## Solution

`rig` is organized around projects, components, lanes, generated deployments,
provider plugins, and a local runtime authority.

Dokploy, sometimes written informally as Docploy in project notes, is a useful product reference point for the rig experience. The goal is not to copy Dokploy one-for-one. The goal is to capture the same sense of simplicity: a wrapper that makes deployment approachable through practical defaults, a clear operational model, and a polished interface. The major distinction is architectural. Dokploy is Docker-first; `rig` is intentionally non-Docker and follows the native local-machine design in the rig spec.

The configuration model defines components once at the top level. Each
component declares whether it is a supervised runtime or an installed
executable. Lanes then override only the fields that actually differ between
the working-copy runtime, the stable built deployment, and generated
deployments.

The operational model uses:

- `local` for the working-copy runtime.
- `live` for the stable built deployment.
- `deployments` as the template for generated deployments, such as branch previews.

Project `rig.json` owns per-project behavior, while a home-level rig config owns
machine/user defaults such as the preferred production branch, generated
deployment caps, replacement policy, and provider defaults. Project config can
override those defaults when a project needs different behavior.

The deployment model is git-push-first. A push to the configured main ref
updates `live`; a push to another ref creates or updates a generated
deployment. CLI deploy commands remain available, but they target refs and
lanes rather than the old environment model. Semver and tags become optional
metadata for labeling and rollback anchors, not a requirement for routine
deploys.

The runtime model uses `rigd` as the local control plane. `rigd` owns
deployment inventory, process supervision, structured logs, health state, port
allocation, deploy actions, provider coordination, and local state
reconciliation. The CLI is a client of `rigd`, and `rigd` provides the
connection boundary for hosted control-plane inspection and actions.

The architecture makes provider selection explicit. `rigd` is the core process
supervisor, launchd is a bundled first-party process-supervisor plugin, and
Caddy/local git remain provider-backed defaults rather than assumptions
embedded in core logic. Stub providers are first-class composition options, so
the main `rig` binary can run end-to-end tests under isolated state.

The backend foundation is Effect-native. Rig targets Effect v4 for backend
logic, Effect Schema for config and argument validation, and Effect CLI for
command parsing. Older Zod and hand-parser assumptions are historical context,
not active architecture.

The completed cutover removed the old implementation. Remaining rollout work
is about validating real providers, hardening Pantry-style deployment flows,
improving setup ergonomics, and following the documented
[state preservation policy](./state-preservation-policy.md) before touching old
runtime state.

## User Stories

1. As a developer working inside a managed repo, I want to run `rig up`, so that I can start the current project without repeating its project name.

2. As a developer working inside a managed repo, I want to run `rig down`, so that I can stop the current project without remembering environment-specific command shapes.

3. As a developer working inside a managed repo, I want to run `rig status`, so that I can see the operational state of the current project immediately.

4. As a developer working outside a managed repo, I want an explicit project selector, so that cross-project operations are intentional.

5. As a developer managing several local projects, I want cross-project commands to require an explicit selector, so that I do not accidentally operate on the wrong project.

6. As an AI agent operating in a repo, I want `rig` to infer the current project, so that instructions can be shorter and less error-prone.

7. As an AI agent operating in a repo, I want `rig` to own long-running lifecycle commands, so that I do not start unmanaged background processes with package manager scripts.

8. As a project maintainer, I want components defined once, so that I do not duplicate nearly identical service definitions across runtime lanes.

9. As a project maintainer, I want lane overrides to be partial patches, so that only meaningful differences are repeated.

10. As a project maintainer, I want a component to declare whether it is managed or installed, so that runtime behavior and executable installation are not mixed together.

11. As a project maintainer, I want managed components to support commands, ports, health checks, hooks, dependencies, proxy exposure, and daemonization, so that long-running services remain fully declarative.

12. As a project maintainer, I want installed components to support build, entrypoint, shim, install strategy, and executable names, so that CLI tools and binaries can be managed without pretending they are services.

13. As a project maintainer, I want dependencies to control startup and shutdown ordering only, so that dependency behavior stays predictable.

14. As a project maintainer, I want dependencies limited to managed components, so that installed tools do not create ambiguous runtime ordering.

15. As a developer, I want `local` to represent my current checkout, so that dev and HMR workflows are clearly separate from built deployments.

16. As a developer, I want `live` to represent the stable built deployment, so that production-like local runtime has one obvious name.

17. As a developer, I want generated deployments for branches, so that preview environments can exist without hand-writing config for each branch.

18. As a developer, I want generated deployments to have isolated workspaces, so that branch previews cannot overwrite each other.

19. As a developer, I want generated deployments to have isolated ports, so that previews can run concurrently.

20. As a developer, I want generated deployments to have isolated logs, so that inspecting one branch does not mix output from another branch.

21. As a developer, I want generated deployments to have isolated runtime state, so that start, stop, health, and cleanup are scoped correctly.

22. As a developer, I want generated deployment domains to default from branch slugs, so that preview URLs are predictable.

23. As a developer, I want generated deployment domains to be overrideable, so that special previews can have stable names.

24. As a developer, I want config interpolation for branch slug, deployment name, workspace path, assigned ports, subdomain, and lane, so that generated deployments do not need duplicated static values.

25. As a developer, I want `git push rig main` to update `live`, so that deployment follows the normal git workflow.

26. As a developer, I want `git push rig <branch>` to create or update a generated deployment, so that review environments are cheap and natural.

27. As a developer, I want CLI deploy commands to remain available, so that scripted and manual deploy workflows are still possible.

28. As a developer, I want semver tags to be optional metadata, so that normal deploys do not require release ceremony.

29. As a developer, I want `rig bump patch`, `rig bump minor`, `rig bump major`, and `rig bump set` to manage version metadata, so that release labels remain available when useful.

30. As a developer, I want rollback anchors to be explicit and traceable, so that returning to a known version is safe.

31. As a developer, I want deploys to preflight dependencies, binaries, env, health checks, hooks, and ports before cutover, so that broken deployments fail before replacing working runtime.

32. As a developer, I want process supervision to be process-group-aware, so that `down` and restarts do not leave orphaned child processes.

33. As a developer, I want structured logs to be the source of truth, so that CLI and web views agree.

34. As a developer, I want automatic port assignment for generated deployments, so that branch previews do not require manual port bookkeeping.

35. As a developer, I want home-level rig defaults for production branch selection and generated deployment limits, so that repeated project setup is minimal and machine-wide policies are consistent.

36. As a developer, I want `rig doctor` to find PATH issues, missing binaries, missing files, health mismatch, port conflicts, stale runtime state, and provider misconfiguration, so that local machine failures are actionable.

37. As a developer, I want accidental partial loss of local state to be recoverable where possible, so that deletion of local rig state is not automatically catastrophic.

38. As a developer, I want recovery to be explicit and bounded, so that `rig` does not silently rewrite state it cannot confidently reconstruct.

39. As an operator, I want one runtime authority, so that deploy inventory, process state, logs, health, and ports are not inferred differently by each command.

40. As an operator, I want `rigd` to own provider coordination, so that provider failures and reconciliation have one place to live.

41. As an operator, I want the CLI to talk to `rigd`, so that command behavior matches the web UI's view of runtime state.

42. As an operator, I want `rigd` to connect to `rig.b-relay.com`, so that the local machine can be inspected and controlled through the hosted control plane when that transport is enabled.

43. As a web UI user, I want to list projects, so that I can see what this machine is managing.

44. As a web UI user, I want to list deployments, so that I can find `local`, `live`, and branch preview runtime state.

45. As a web UI user, I want to inspect logs and health, so that I can debug without shell access.

46. As a web UI user, I want to trigger lifecycle and deploy actions, so that routine operations can be done from the web UI.

47. As a web UI user, I want to edit config, so that basic operational changes do not require direct file editing.

48. As a project maintainer, I want package-manager integration to be optional, so that non-JavaScript projects are unaffected.

49. As a project maintainer, I want package-manager integration to generate `rig:` scripts when enabled, so that team members can discover the rig workflow from familiar tooling.

50. As a project maintainer, I want package-manager integration not to overwrite conventional scripts by default, so that existing workflows are not broken unexpectedly.

51. As a test author, I want the main `rig` binary to run under an isolated state root, so that end-to-end tests exercise shipped behavior.

52. As a test author, I want stub providers for process supervision, proxy management, SCM, and other external concerns, so that tests cannot mutate real machine state.

53. As a test author, I want the separate smoke-only binary to stay retired, so that end-to-end coverage exercises the shipped `rig` binary.

54. As a contributor, I want external concerns to remain behind interfaces, so that the plugin architecture is enforceable.

55. As a contributor, I want providers to be selected at composition time, so that rigd, launchd, Caddy, and local git do not leak into core logic.

56. As a contributor, I want new docs and onboarding to use rig concepts, so that users learn the model we are building toward.

57. As a new user, I want `rig init` to scaffold a useful base config, so that setup is more than just a registry entry.

58. As a new user, I want `rig init` to remain non-interactive, so that humans and AI agents can run it in scripts.

59. As a new user, I want `rig init` to support provider selection, lane wiring, and optional package-manager integration, so that a project can be initialized into the rig model in one explicit flow.

60. As a maintainer, I want tests and agent runs to use isolated state, so that development cannot mutate real machine state.

61. As a maintainer, I want clear non-goals, so that rig does not expand into app presets, broad tool dependency modeling, or a separate rig website.

62. As a contributor, I want rig backend logic to target Effect v4, so that new runtime code is built on the current Effect architecture.

63. As a contributor, I want config and argument validation to use Effect Schema, so that validation, typed data, and structured errors live in the same Effect-native model.

64. As a contributor, I want CLI parsing to use Effect CLI, so that command parsing, help output, and execution compose with Effect services and errors.

65. As an operator, I want old runtime state to follow the documented preservation policy, so that cutover does not accidentally destroy recoverable state.

66. As a contributor, I want the shipped `rig` binary to be testable with `RIG_ROOT` and stub providers, so that end-to-end coverage exercises the real entrypoint safely.

67. As a contributor, I want rig to use isolated state, labels, workspaces, logs, ports, and proxy entries in tests, so that development cannot collide with real machine state.

68. As a maintainer, I want rig to keep proven process, provider, logger, health, and test ideas without preserving old product assumptions.

## Implementation Decisions

- The rig product model is repo-first. Commands should infer the current project when run inside a managed repo, and cross-project targeting should require an explicit selector.

- Rig is the main implementation. The historical parallel runway is complete.

- Test and agent state must be isolated with `RIG_ROOT`. This includes state
  root, launchd labels, workspaces, logs, proxy entries, ports, and runtime
  metadata.

- Rig may reuse proven older implementation patterns where they fit the current model. It should not preserve old `dev`/`prod`, `server`/`bin`, semver-first deploy, Zod, or hand-parser assumptions where those conflict with rig.

- Rig backend logic targets Effect v4. Package constraints and verified API details live in `docs/effect-v4-help-notes.md`.

- Contributors should consult `docs/effect-v4-help-notes.md` before Effect v4 implementation or review work, and keep it updated with verified APIs, migration details, Bun integration patterns, package constraints, and useful source links.

- Rig config validation and argument validation should use Effect Schema instead of Zod.

- Rig CLI parsing should use Effect CLI instead of hand-written `node:util` parsing. Help output and parse failures should still map to the existing structured logger/error behavior.

- The rig lifecycle model is centered on `up`, `down`, `logs`, `status`, `deploy`, `bump`, `doctor`, and `init`.

- The rig deployment model uses `local`, `live`, and generated `deployments` instead of duplicated `dev` and `prod` environment definitions.

- The rig config model defines shared components once and applies lane-specific overrides as partial patches.

- Rig has both project config and home config. Project config travels with the
  repo and defines components plus project-specific overrides. Home config
  stays on the machine and supplies defaults for production branch behavior,
  generated deployment limits, replacement policy, provider defaults, and
  web-control preferences.

- Component mode replaces the old server/bin distinction. `managed` means supervised long-running runtime. `installed` means executable installation/build output.

- Dependency semantics remain intentionally narrow. Dependencies affect startup and shutdown ordering only.

- Generated deployments are materialized from the `deployments` template and must have isolated workspace, port, log, and runtime state.

- Git push is the primary deploy path. CLI deploy commands remain, but they should target refs and lanes rather than requiring semver release flow.

- Semver and tags remain available as optional metadata and rollback anchors through the `bump` flow.

- `rigd` is the runtime authority. CLI commands and web operations should read and mutate runtime state through `rigd` instead of reassembling truth independently.

- `rigd` should be manageable as a normal managed component, while still owning the control plane responsibilities once running.

- `rigd` connects outbound to the hosted web control plane. The redesign does not introduce a separate rig website.

- Provider families must include process supervision, proxy/routing, SCM integration, workspace/deployment materialization, logging/event transport, control-plane transport, health checking, and package-manager integration.

- Default providers can remain core rigd, Caddy, and local git. Launchd remains a bundled first-party process-supervisor plugin selectable through the same provider interface as future external plugins. Core logic should depend on interfaces and provider composition rather than concrete implementations.

- Stub providers must be first-class provider choices, not smoke-test-only hacks.

- The main binary must stay testable with isolated state and stub providers.

- Deploy reliability requires preflight before cutover for dependency installation, binary availability, env resolution, health check validity, hook availability, and port reservation.

- Runtime supervision should be process-group-aware so that stop and restart operations do not leave orphaned descendants.

- Structured logs should become the shared source of truth for both CLI and web views.

- Generated deployments require automatic port assignment.

- `doctor` should diagnose local-machine and provider failures rather than requiring users to infer them from lower-level errors.

- Recoverable state is a goal, but reconstruction must be conservative. The system may reconstruct minimum operational state from runtime/provider/deployment/SCM metadata when safe.

- `rig init` should become a real non-interactive setup tool that scaffolds config structure, provider/plugin selection, lane wiring, and optional package-manager integration.

- Package-manager integration is optional and setup-time only. It may add `rig:` scripts, but it must not overwrite conventional scripts by default.

- Post-cutover work should be thin vertical slices: prove one real behavior end
  to end, keep docs/issues current, then broaden.

## Testing Decisions

- Tests should verify externally observable behavior rather than internal implementation details.

- Config tests should cover the rig Effect Schema shape, required field documentation, mode-specific validation, lane override validation, interpolation validation, dependency validation, and localhost-only network constraints.

- Config resolution tests should cover component inheritance, lane override application, generated deployment interpolation, and invalid override failures.

- Effect CLI parser tests should cover repo-first project inference, explicit project selection, help output for every subcommand, and invalid cross-project usage.

- Effect v4 migration tests should cover representative service/layer wiring, tagged errors, config validation, CLI parsing, and command execution paths before broader rig work depends on the new stack.

- Lifecycle tests should cover `up`, `down`, restart behavior where retained, dependency ordering, hook execution, env loading, bin installation behavior, and rollback on partial failure.

- Deployment tests should cover git-push-derived deploy intent, `live` updates, generated deployment creation/update, CLI deploy targets, semver metadata, rollback anchors, preflight failures, and cutover safety.

- Runtime authority tests should cover `rigd` inventory ownership, health state ownership, port allocation, log streaming, provider coordination, and reconciliation behavior.

- Provider composition tests should verify that launchd, Caddy, local git, and stub providers can be selected without changing core logic.

- Main-binary E2E tests should run with isolated state and stub providers, proving that the shipped binary can be safely tested without a smoke-only executable.

- The rig entrypoint should keep E2E coverage proving it can run under isolated
  state without mutating real machine state.

- Recovery tests should cover missing or partial local state, active runtime state, provider state, and cases where reconstruction must fail instead of guessing.

- Doctor tests should cover PATH issues, missing binaries/files, health mismatch, port conflicts, stale runtime state, and provider misconfiguration.

- Web/control-plane tests should cover the local API contract before web UI integration depends on it.

- Package-manager integration tests should cover opt-in script generation, no default overwrites of conventional scripts, and no impact on non-JavaScript projects.

- Prior test patterns already exist for schema validation, CLI parsing, lifecycle orchestration, deploy orchestration, provider behavior, and smoke-style command workflows. New tests should extend those behavior-focused patterns rather than snapshotting fragile internals.

## Out of Scope

- App presets are not part of rig.

- A built-in migration CLI command is not part of rig.

- A separate rig website is not part of rig. The web surface is the hosted control plane at `rig.b-relay.com`.

- Broad dependency modeling for installed tools or prerequisites is not part of rig.

- Dependencies do not imply restart propagation or runtime cascade behavior after boot.

- Package-manager integration does not replace `rig` as the lifecycle authority.

- Package-manager integration does not overwrite `dev`, `start`, or similar conventional scripts by default.

- Semver tags are not required for normal deploys.

- Silent reconstruction of all lost state is not a goal. Recovery should happen only where the system has enough evidence to do it safely.

- Automatic migration of historical runtime state is not part of this PRD.
  State migration or deletion must follow the
  [state preservation policy](./state-preservation-policy.md).

## Further Notes

Documentation and onboarding should describe the current rig vocabulary before
historical context.

Keep the Dokploy context visible during future planning sessions. It explains the product feel `rig` is aiming for: simple deployment wrapper, useful interface, strong default workflows, and broad deployment features. The differentiator is that `rig` reaches for those outcomes without making Docker or containers the runtime substrate.

Rig is now promoted to the main `rig` entrypoint. The goal is still to protect
always-on apps such as `pantry` by keeping historical state untouched until an
explicit state migration or deletion action is approved through the
[state preservation policy](./state-preservation-policy.md).

Provider selection is explicit enough for the main binary to run in isolated test mode. That keeps end-to-end coverage close to the shipped CLI.

The most consequential boundary is `rigd`. New runtime-facing functionality
should be designed around `rigd` ownership.

The initial rig operating decisions are recorded in `DESIGN.md`. In short: cross-project operations use `--project <name>`, repo-first commands outside a managed repo fail unless explicitly targeted, path-based lifecycle targeting is rejected, simultaneous same-port runtime conflicts fail during preflight, health checks must be tied to rig-owned runtime state, explicit status for undeployed runtime targets fails, and aggregate runtime logs include managed components only.

Earlier reliability issues around stale release metadata, dirty release deploys,
false-positive port health, missing runtime versions, and installed-component
logs should be handled as rig-aligned reliability work.
