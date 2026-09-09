# Issue 90: truthful Target port selection

Base: `4a1999ef719f8fd8b08fbf3849e88e4a580ebf3e`.
Worktree: `/tmp/rig-issue-90`; branch: `refactor/issue-90-port-selection`.

## Interface decision

Before: `reservePorts(requests, occupied, dynamic)` returned numbers after closing
its probe sockets. The name suggested retained ownership and its positional boolean
hid Preview policy. After: `selectPorts({ requests, occupied, policy })` returns
selected numbers with an explicit `configured` or `dynamic` policy. The shared
contract states that all probes close before return, inventory exclusion is read
only, and competitors can acquire ports before startup. Configured preferred ports
are requirements; omitted preferences dynamically select. Preview ignores preferences.

Compared two shapes using function-design and codebase-design: (1) one selection
request with a domain policy, and (2) separate configured/dynamic operations or a
retained lease object. Separate operations would duplicate shared selection policy;
a lease would expose lifetime/handoff obligations to providers and change behavior.
Chose the single request, with no new service, socket lease, retry, or storage format.

## Function contract ledger and direct callers

- `createRuntimeFiles` / `selectPorts`: inputs are validated unique named requests,
  read-only inventory numbers, and selection policy. Returns a fresh complete map;
  local `selected` and `used` are owned mutations, and caller inputs are unchanged.
  The adapter owns ambient OS localhost socket allocation; no socket survives a
  successful probe. `availablePort` (trusted by real binding tests) binds only
  `127.0.0.1`, closes before resolving, and maps listen errors to PORT_UNAVAILABLE.
  A failed listen owns no listening socket. Earlier probes have already closed on
  partial failure. PORT_RESERVED remains the existing configured inventory failure.
  OS allocation and its existing occupied-number retry loop remain inherited debt;
  this ticket adds no cancellation or bounded retry policy. Existing close errors
  still propagate unchanged. Empty input returns an empty map without probing.
- `planTarget`: caller job is to resolve a Target with usable selected numbers.
  Inputs include explicit runtime dependencies, project/config/Target/source facts.
  It reads inventory through the store, excludes the existing Target, reuses its
  compatible recorded numbers, selects only missing ports, and returns a fresh
  Target with resolved plan. Its store/documents/clock dependencies remain explicit;
  source preparation and filesystem effects retain their existing owners. Selector
  results prove neither continued OS availability nor readiness. `selectPorts`,
  recorded-port mapping and config resolver are trusted by planning/config tests.
  Policy selection is now visible at the call: Preview dynamic, local/live configured.
  Recorded port reuse deliberately does not re-probe a running component.
- `resolveTargetPlan` direct-caller contract comment now identifies assigned numbers,
  not socket reservations. Pure resolution still validates conflicts and expands
  configured values; no body, input, error, or result format changed.
- Runtime test doubles implement the renamed selection capability. Production
  lifecycle/startup and Preview allocation call sites were reread: provider startup,
  configured health checks and rollback remain the execution owners. No caller
  receives a retained listener or release operation.
- New tests own isolated sockets/processes and temporary roots. They consume public
  RuntimeFiles, runtime command, lifecycle and supervisor seams. Bun networking,
  spawn, filesystem and fetch are explicit fixture effects, verified by actual
  competitor binding, application EADDRINUSE logs, prior HTTP response, and rebind
  after cleanup. The finite competitor child exits after its one binding. The
  lifecycle fixture stops its owned supervisor and listener in finally; no real Rig
  state, launchd or Caddy is used.

## Verification

TDD red: the first public selection/other-process binding test failed with
`TypeError: files.selectPorts is not a function`. Minimal rename/request conversion
made it green: 1 test, 3 assertions. Added compatibility/cleanup tests without
changing the probe algorithm.

The matrix covers empty input, preferred port identity, multiple dynamic requests,
read-only inventory collision, unavailable configured port, dynamic fallback despite
an occupied preference, distinct results, partial success followed by failure, and
rebinding all successful selections. A separate isolated Bun process binds the
selected preferred port after return. Runtime commands exercise actual selector
local/Preview inventory exclusion and retention of recorded local ports.

Controlled contention uses a real competitor occupying the selected web port. The
application's captured output contains EADDRINUSE; its configured HTTP check fails
against the competitor's 503. Lifecycle rejects HEALTH_FAILED with useful guidance,
rolls back, preserves the pre-existing API process/HTTP response and Target bytes,
and both selected ports can be bound after owned cleanup.

- `RIG_ROOT=/tmp/rig-issue90-focused2/.rig bun test tests/port-selection.test.ts tests/runtime-lifecycle.test.ts tests/runtime-application.test.ts tests/deployment-e2e.test.ts tests/runtime-review-regressions.test.ts`: 71 pass, 0 fail, 329 assertions.
- After adding the real local/Preview planning regression:
  `RIG_ROOT=/tmp/rig-issue90-planning/.rig bun test tests/runtime-application.test.ts tests/port-selection.test.ts tests/runtime-lifecycle.test.ts`: 66 pass, 0 fail, 307 assertions.
- `bun run typecheck`: passed after both focused runs.
- Initial broader run exposed missing worktree dependencies (commander/yaml);
  `bun install --frozen-lockfile` restored the lockfile dependencies, then reruns passed.

Full suite, compiled entrypoint gates and independent review are supervisor-owned.
No claim of those gates being complete is made here.

## Preserved limitations

The child supervisor reports process spawn, not proof of a successful application
bind. A no-health component may initially report started before its later bind
failure is observed. A competitor that returns a successful generic HTTP health
response can also fool that check; health alone proves no listener ownership. An
initial no-health test demonstrated this inherited behavior, so contention coverage
uses the existing configured failure/rollback path rather than changing readiness
policy. These limits were reported to the supervisor and explicitly left in scope
as documentation only. There is no exclusive future ownership guarantee.
