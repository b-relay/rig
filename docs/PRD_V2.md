# rig v2 PRD

## Problem Statement

`rig` is already useful as a local Mac deployment manager, but the current product model makes the common workflow harder than it needs to be for humans and AI agents.

Users must think in terms of duplicated `dev` and `prod` environment definitions, repeatedly pass explicit project names even when they are already inside a managed repo, and rely on a release/tag-oriented production flow for deploys that should usually be driven by git pushes. Runtime state is also assembled directly by commands from local files and provider state, which makes reliability, recovery, and future web visibility harder.

The current architecture has good interface boundaries, but provider selection and test-safe provider composition are not first-class enough. The separate smoke binary is a symptom of that gap: end-to-end tests need isolation from launchd, Caddy, git state, workspaces, and user machine state, but the main binary cannot yet be composed safely enough for that purpose.

The current implementation also mixes Effect with separate validation and CLI parsing libraries. That was a practical v1 choice, but v2 should consolidate backend logic around the Effect ecosystem so command execution, schemas, parsing, services, layers, and errors share one model.

The result is a system that works, but asks users and agents to carry too much operational context:

- Which project am I targeting?
- Is this a long-running runtime or an installed executable?
- Is this a dev environment, a prod environment, a release, a workspace, or a version?
- Can I safely deploy this branch without manually creating semver tags?
- Can the CLI and future web UI trust the same runtime state?
- Can tests use the real binary without touching real machine integrations?

`rig` v2 should collapse those decisions into one obvious repo-first, lifecycle-first workflow while preserving the strict architectural boundary that keeps external concerns testable and swappable.

## Solution

`rig` v2 will redesign the product around projects, components, lanes, generated deployments, provider plugins, and a local runtime authority.

Dokploy, sometimes written informally as Docploy in project notes, is a useful product reference point for the v2 experience. The goal is not to copy Dokploy one-for-one. The goal is to capture the same sense of simplicity: a wrapper that makes deployment approachable through practical defaults, a clear operational model, and a polished interface. The major distinction is architectural. Dokploy is Docker-first; `rig` is intentionally non-Docker and follows the native local-machine design in the v2 spec.

The new configuration model defines components once at the top level. Each component declares whether it is a supervised runtime or an installed executable. Lanes then override only the fields that actually differ between the working-copy runtime, the stable built deployment, and generated deployments.

The new operational model uses:

- `local` for the working-copy runtime.
- `live` for the stable built deployment.
- `deployments` as the template for generated deployments, such as branch previews.

The new deployment model is git-push-first. A push to the configured main ref updates `live`; a push to another ref creates or updates a generated deployment. CLI deploy commands remain available, but they target refs and lanes rather than the old environment model. Semver and tags become optional metadata for labeling and rollback anchors, not a requirement for routine deploys.

The new runtime model introduces `rigd` as the local control plane. `rigd` owns deployment inventory, process supervision, structured logs, health state, port allocation, deploy actions, provider coordination, and local state reconciliation. The CLI becomes a client of `rigd`, and `rigd` provides the authenticated connection that allows the web UI at `rig.b-relay.com` to inspect and control the local machine.

The new architecture makes provider selection explicit. `rigd` is the core process supervisor, launchd is a bundled first-party process-supervisor plugin, and Caddy/local git remain provider-backed defaults rather than assumptions embedded in core logic. Stub providers become first-class composition options, which allows the main `rig` binary to run end-to-end tests under isolated state without needing a separate smoke-only binary.

The new backend foundation is Effect-native. V2 targets Effect v4 for backend logic, Effect Schema for config and argument validation, and Effect CLI for command parsing. Legacy Zod schemas and hand-written parser code can remain only as migration scaffolding for v1 compatibility.

The rollout should be incremental and isolated. The current v1 `rig` binary must remain available to manage production apps, especially always-on hosted apps such as `pantry`, while v2 is developed. V2 should have a separate dev binary or entrypoint, such as `rig2`, plus isolated state, labels, workspaces, logs, ports, and proxy entries. After v2 is ready, production apps can cut over deliberately; v1 does not need to remain the long-term user experience.

The current implementation remains supported during migration while new docs, onboarding, provider composition, `rigd`, and the v2 config/CLI model are introduced in phases.

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

35. As a developer, I want `rig doctor` to find PATH issues, missing binaries, missing files, health mismatch, port conflicts, stale runtime state, and provider misconfiguration, so that local machine failures are actionable.

36. As a developer, I want accidental partial loss of local state to be recoverable where possible, so that deletion of local rig state is not automatically catastrophic.

37. As a developer, I want recovery to be explicit and bounded, so that `rig` does not silently rewrite state it cannot confidently reconstruct.

38. As an operator, I want one runtime authority, so that deploy inventory, process state, logs, health, and ports are not inferred differently by each command.

39. As an operator, I want `rigd` to own provider coordination, so that provider failures and reconciliation have one place to live.

40. As an operator, I want the CLI to talk to `rigd`, so that command behavior matches the web UI's view of runtime state.

41. As an operator, I want `rigd` to connect to `rig.b-relay.com`, so that the local machine can be inspected and controlled through the hosted control plane when that transport is enabled.

42. As a web UI user, I want to list projects, so that I can see what this machine is managing.

43. As a web UI user, I want to list deployments, so that I can find `local`, `live`, and branch preview runtime state.

44. As a web UI user, I want to inspect logs and health, so that I can debug without shell access.

45. As a web UI user, I want to trigger lifecycle and deploy actions, so that routine operations can be done from the web UI.

46. As a web UI user, I want to edit config, so that basic operational changes do not require direct file editing.

47. As a project maintainer, I want package-manager integration to be optional, so that non-JavaScript projects are unaffected.

48. As a project maintainer, I want package-manager integration to generate `rig:` scripts when enabled, so that team members can discover the rig workflow from familiar tooling.

49. As a project maintainer, I want package-manager integration not to overwrite conventional scripts by default, so that existing workflows are not broken unexpectedly.

50. As a test author, I want the main `rig` binary to run under an isolated state root, so that end-to-end tests exercise shipped behavior.

51. As a test author, I want stub providers for process supervision, proxy management, SCM, and other external concerns, so that tests cannot mutate real machine state.

52. As a test author, I want to retire the separate smoke-only binary, so that there is less duplicate test surface.

53. As a contributor, I want external concerns to remain behind interfaces, so that the plugin architecture is enforceable.

54. As a contributor, I want providers to be selected at composition time, so that rigd, launchd, Caddy, and local git do not leak into core logic.

55. As a contributor, I want new docs and onboarding to use v2 concepts, so that users learn the model we are building toward.

56. As a new user, I want `rig init` to scaffold a useful base config, so that setup is more than just a registry entry.

57. As a new user, I want `rig init` to remain non-interactive, so that humans and AI agents can run it in scripts.

58. As a new user, I want `rig init` to support provider selection, lane wiring, and optional package-manager integration, so that a project can be initialized into the v2 model in one explicit flow.

59. As a maintainer, I want v2 to be isolated while it is incomplete, so that the replacement CLI can be built quickly without mutating current machine state.

60. As a maintainer, I want clear non-goals, so that v2 does not expand into app presets, broad tool dependency modeling, or a separate rig website.

61. As a contributor, I want v2 backend logic to target Effect v4, so that new runtime code is built on the current Effect architecture.

62. As a contributor, I want config and argument validation to use Effect Schema, so that validation, typed data, and structured errors live in the same Effect-native model.

63. As a contributor, I want CLI parsing to use Effect CLI, so that command parsing, help output, and execution compose with Effect services and errors.

64. As an operator, I want v1 `rig` to remain available while v2 is in development, so that current local workflows stay available until the replacement rename is deliberate.

65. As a contributor, I want a separate v2 dev binary or entrypoint, so that I can test v2 behavior without affecting the production v1 binary.

66. As a contributor, I want v2 to use isolated state, labels, workspaces, logs, ports, and proxy entries, so that v2 cannot accidentally collide with v1-managed production state.

67. As a maintainer, I want v2 to reuse proven v1 patterns selectively, so that we keep working process, provider, logger, health, and test ideas without preserving v1 product assumptions.

## Implementation Decisions

- The v2 product model is repo-first. Commands should infer the current project when run inside a managed repo, and cross-project targeting should require an explicit selector.

- V2 should be built as a parallel implementation path during development. The existing `rig` binary remains the v1 production manager until explicit cutover.

- V2 should have a separate dev binary or entrypoint, such as `rig2`, until it is safe to replace the main `rig` binary.

- V2 state must be isolated from v1 state during development. This includes state root, launchd labels, workspaces, logs, proxy entries, ports, and runtime metadata.

- V2 may copy or reuse proven v1 code patterns where they fit the new model. It should not preserve v1's `dev`/`prod`, `server`/`bin`, semver-first deploy, Zod, or hand-parser assumptions where those conflict with v2.

- V2 backend logic targets Effect v4. If Effect v4 is still prerelease when implementation starts, the project should pin an explicit v4 beta and document the later stable upgrade path.

- Contributors should consult `docs/effect-v4-help-notes.md` before Effect v4 implementation or review work, and keep it updated with verified APIs, migration details, Bun integration patterns, package constraints, and useful source links.

- V2 config validation and argument validation should use Effect Schema instead of Zod. Legacy Zod schemas may remain only where needed for v1 compatibility during migration.

- V2 CLI parsing should use Effect CLI instead of hand-written `node:util` parsing. Help output and parse failures should still map to the existing structured logger/error behavior.

- The v2 lifecycle model is centered on `up`, `down`, `logs`, `status`, `deploy`, `bump`, `doctor`, and `init`.

- The v2 deployment model uses `local`, `live`, and generated `deployments` instead of duplicated `dev` and `prod` environment definitions.

- The v2 config model defines shared components once and applies lane-specific overrides as partial patches.

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

- The main binary should become testable with isolated state and stub providers. The separate smoke binary is transitional, not the target.

- Deploy reliability requires preflight before cutover for dependency installation, binary availability, env resolution, health check validity, hook availability, and port reservation.

- Runtime supervision should be process-group-aware so that stop and restart operations do not leave orphaned descendants.

- Structured logs should become the shared source of truth for both CLI and web views.

- Generated deployments require automatic port assignment.

- `doctor` should diagnose local-machine and provider failures rather than requiring users to infer them from lower-level errors.

- Recoverable state is a goal, but reconstruction must be conservative. The system may reconstruct minimum operational state from runtime/provider/deployment/SCM metadata when safe.

- `rig init` should become a real non-interactive setup tool that scaffolds config structure, provider/plugin selection, lane wiring, and optional package-manager integration.

- Package-manager integration is optional and setup-time only. It may add `rig:` scripts, but it must not overwrite conventional scripts by default.

- The migration should be phased: docs and onboarding first, then provider selection and stub composition, then `rigd`, then v2 CLI/config semantics, then retirement of the smoke binary.

## Testing Decisions

- Tests should verify externally observable behavior rather than internal implementation details.

- Config tests should cover the v2 Effect Schema shape, required field documentation, mode-specific validation, lane override validation, interpolation validation, dependency validation, and localhost-only network constraints.

- Config resolution tests should cover component inheritance, lane override application, generated deployment interpolation, and invalid override failures.

- Effect CLI parser tests should cover repo-first project inference, explicit project selection, help output for every subcommand, invalid cross-project usage, and backwards-compatible transitional command behavior.

- Effect v4 migration tests should cover representative service/layer wiring, tagged errors, config validation, CLI parsing, and command execution paths before broader v2 work depends on the new stack.

- Lifecycle tests should cover `up`, `down`, restart behavior where retained, dependency ordering, hook execution, env loading, bin installation behavior, and rollback on partial failure.

- Deployment tests should cover git-push-derived deploy intent, `live` updates, generated deployment creation/update, CLI deploy targets, semver metadata, rollback anchors, preflight failures, and cutover safety.

- Runtime authority tests should cover `rigd` inventory ownership, health state ownership, port allocation, log streaming, provider coordination, and reconciliation behavior.

- Provider composition tests should verify that launchd, Caddy, local git, and stub providers can be selected without changing core logic.

- Main-binary E2E tests should run with isolated state and stub providers, proving that the shipped binary can be safely tested without a smoke-only executable.

- During v2 development, `rig2` or the v2 entrypoint should have E2E coverage proving it cannot read or mutate v1 production state by default.

- Recovery tests should cover missing or partial local state, active runtime state, provider state, and cases where reconstruction must fail instead of guessing.

- Doctor tests should cover PATH issues, missing binaries/files, health mismatch, port conflicts, stale runtime state, and provider misconfiguration.

- Web/control-plane tests should cover the local API contract before web UI integration depends on it.

- Package-manager integration tests should cover opt-in script generation, no default overwrites of conventional scripts, and no impact on non-JavaScript projects.

- Prior test patterns already exist for schema validation, CLI parsing, lifecycle orchestration, deploy orchestration, provider behavior, and smoke-style command workflows. New tests should extend those behavior-focused patterns rather than snapshotting fragile internals.

## Out of Scope

- App presets are not part of v2.

- A built-in migration CLI command is not part of v2.

- A separate rig website is not part of v2. The web surface is the hosted control plane at `rig.b-relay.com`.

- Broad dependency modeling for installed tools or prerequisites is not part of v2.

- Dependencies do not imply restart propagation or runtime cascade behavior after boot.

- Package-manager integration does not replace `rig` as the lifecycle authority.

- Package-manager integration does not overwrite `dev`, `start`, or similar conventional scripts by default.

- Semver tags are not required for normal deploys.

- Silent reconstruction of all lost state is not a goal. Recovery should happen only where the system has enough evidence to do it safely.

- Automatic migration of v1-managed production apps to v2 is not part of this PRD. Cutover should be explicit.

## Further Notes

The first implementation milestone should be documentation and onboarding alignment. Users and contributors need to see the v2 vocabulary before the deeper architecture changes land.

Keep the Dokploy context visible during future planning sessions. It explains the product feel `rig` is aiming for: simple deployment wrapper, useful interface, strong default workflows, and broad deployment features. The differentiator is that `rig` reaches for those outcomes without making Docker or containers the runtime substrate.

Treat `rig2` as the v2 runway while production still depends on v1. The goal is not to keep two products forever; the goal is to protect always-on apps such as `pantry` until the v2 cutover is intentional.

The next milestone should make provider selection explicit enough that the main binary can run in isolated test mode. That unlocks safer end-to-end testing and reduces dependence on the smoke-only binary.

The most consequential milestone is `rigd`. It should be treated as the boundary between legacy command-assembled runtime truth and the v2 control-plane model. The CLI can migrate incrementally, but new runtime-facing functionality should be designed around `rigd` ownership.

The initial v2 operating decisions are recorded in `docs/DESIGN_V2.md`. In short: cross-project operations use `--project <name>`, repo-first commands outside a managed repo fail unless explicitly targeted, path-based lifecycle targeting is rejected, simultaneous same-port runtime conflicts fail during preflight, health checks must be tied to rig-owned runtime state, explicit status for undeployed runtime targets fails, and aggregate runtime logs include managed components only.

One migration decision remains intentionally later-stage: whether the smoke binary is removed entirely or kept temporarily as a thin harness. That is handled by the rig-smoke retirement work after main-binary isolated E2E coverage exists.

Smoke-discovered reliability issues around stale release metadata, dirty release deploys, false-positive port health, missing prod versions, and installed-component logs should be handled as v2-aligned reliability work even if they land before the full v2 migration.
