# Issue #242 run notes — activation gates and route maps

Branch `feat/issue-242-activation-gates`, PR against `feat/issue-114-config-cutover`.
No runtime was installed and no live daemon, job, route or data was touched; every
test runs in a temporary `RIG_ROOT`, and the real-Caddy smoke runs its own Caddy
on reserved loopback ports with its own admin address.

## What changed

- A Service may declare several named ports or none. The plan keeps `port` (the
  first, for status) and adds `ports` (all, by name). Assigned ports are keyed
  `<service>.<port>`; a plan saved before this change keyed the first port by the
  Service's name, and that key is still honoured.
- `proxy` is a route map. The plan adds `proxy.routes: { prefix, service, port }[]`,
  longest prefix first. `plannedRoutes(plan)` reads a plan saved before this
  change (only `upstream`) as its single `/` route. The Caddy router renders one
  owned block per Target: `handle` blocks with a `path /p /p/*` matcher in the
  given order, then `/`; a lone `/` renders as before, so existing Caddyfiles do
  not change.
- Readiness: explicit `ready`, else a connection to every declared port
  (`PortProbe`, 127.0.0.1 then ::1), else the liveness grace period.
- After readiness and before hooks, success or route publication, the lifecycle
  inspects what the Service's process tree listens on (`ListenerInspection`):
  non-loopback → `LISTENER_NONLOCAL`; owner or sockets not established →
  `LISTENER_UNKNOWN`; a routed port (and, without `ready`, a declared port) that
  no owned process listens on → not ready, retried until `ready_timeout`.
- Routes are withheld before a process is spawned: `up` withholds the paths of
  routed Services it found stopped, `recover` the path of the Service it starts.
  A withheld path answers 503; siblings keep their upstreams. After verification
  the whole map is published. A failed replacement stays withheld.
- An already-running prerequisite is verified with the same gate (not only when
  it has `ready`), in `up` and in `recover`.
- `HEALTH_FAILED` details carry `outcome: unanswered | unready`.
- The "several ports", "no port" and "prefix other than `/`" refusals are gone.

## Decisions

**Listener inspection shape.** A, chosen: a provider that returns facts,
`ListenerInspection.inspect(pid, signal) → observed{listeners} | unknown{reason}`,
with the policy (what is loopback, which ports must be owned) as pure code in the
lifecycle. B, rejected: `Supervisor.observe` returns listeners. Both supervisors
and every supervisor double would repeat OS inspection, and a status read would
pay for `lsof`. C, rejected: the provider returns a verdict
(`verify({pid, ports}) → safe | unsafe`). The loopback rule would live in an
adapter, each adapter would need its own copy, and the lifecycle tests could not
state the rule through the interface.

**Route gate shape.** A, chosen: one `effects.route(target, change)`
that publishes the Target's whole desired map, with withheld Services' paths at
503 (`change` is `{withhold}` or `{verified}`; see review round 1). It is one atomic owned Caddy block, so "preserve unrelated routes" is
structural and the existing route checkpoint covers it. B, rejected: incremental
`Router.withdraw(prefix)` / `publish(prefix)`. It adds per-prefix state, partial
failure combinations, and a second checkpoint format.

**Withdraw before spawn.** The route a predecessor had must not reach its
replacement, and a replacement's port answers as soon as it binds. So withdrawal
is the step before the spawn. If it fails, nothing is started: in `recover` the
error is recorded as `activation-failed` (retryable, spends budget) and the
process that is not there cannot be reached.

**Indeterminate fails.** The owner is observed before and after the inspection and
must be the same running pid; `unknown` evidence, a missing pid, or a changed pid
is `LISTENER_UNKNOWN`. None of the listener errors are waited out.

**Deadline.** `awaitActivation` races the health check and the inspection against
the `ready_timeout` expiry, so a provider that ignores cancellation cannot hold
the start; the rollback stops the process, and a late answer finds nothing to
publish because publication is a later step of the same (already failed) call.

**Evidence boundary.** Inspection is a moment, not containment: a process can
bind elsewhere afterwards. TCP only. Documented in the guide.

**Known limits, not changed.** Upstreams are `127.0.0.1:<port>`, so a routed port
bound only to `::1` passes the gate and is not routable (readiness accepts ::1
because unrouted ports may use it). The final publish in `recover` does not
withhold stopped siblings: their dead ports answer 502, and any later start
withdraws first. The liveness grace period of a Service without readiness runs
before `ready_timeout` starts and is not bounded by it (unchanged behaviour).
Status still says `running` for a Service without `ready`.
`ActivationJournal.activated` stays a no-op seam.

## Function-design ledger (findings only)

| Function | Finding | Resolution |
| --- | --- | --- |
| `createListenerInspection` | Effects: two commands through the injected `CommandRunner`, fixed `PATH`/`LC_ALL`, 5 s each. Never rejects; every failure is `unknown`, which is never "nothing listens". lsof exit 1 is ambiguous (nothing listed / a pid ended), so only a silent stderr counts as an answer. | Contract on the interface; contract test with real processes. |
| `probeLocalPort` | Opens sockets (ambient network) — it is the adapter; injected as `PortProbe` so the effects adapter stays controllable. Says only that something answers, not who. | Ownership is the inspection's job; stated on the type. |
| `awaitActivation` | One owner for deadline, retry and both checks, shared by `up`, `recover` and prerequisite verification. Distinguishes provider rejection (own error, immediate), expiry (`unanswered`), unready answer (`unready`), and unknown ownership (`LISTENER_UNKNOWN`). | — |
| `localListeners` | Reads the owner twice around the inspection; pure policy otherwise. | — |
| `loopbackAddress` | Pure; exported for its table test. | — |
| `effects.route` | Now total over the plan's map; the change names Services, not prefixes, because the caller knows Services. Reads the published route (`Router.withheld`) so that what is withheld is state of the route itself, not of a caller: it survives a daemon restart and a sibling's publication. Throws `ROUTE_UPSTREAM` for a routed Target with no routes. | Required `change` argument: a caller must say whether it withholds or has verified. |
| `Router.withheld` | Reads the owned block back; no reload, no write. A published prefix the plan no longer routes is ignored by the caller. | Contract test on the rendered text. |
| `CaddyRouter.change` | The unchanged-file shortcut assumed the file is what Caddy serves. | A withdrawal always reloads; an unchanged publication still does not. |
| `resolve.declaredPorts` / `ports.declaredPorts` | Two readers of "a component's ports": one builds the plan, one reads plans including legacy ones. | Kept apart: different inputs (config vs. saved plan). |

Inherited debt named, not changed: test doubles of `TargetEffects` are hand-built
in several suites; each needed `listeners` and a pid on running observations.

## Evidence

- Process note: the first draft of the lifecycle change was written before its
  test. To get an honest red, the withdrawal line in `recover` was removed:
  all three first tests in `tests/activation-gates.test.ts` failed with
  `expect(received).toBeNull() Received: "127.0.0.1:46102"`, and passed with it
  restored. Later, disabling `up`'s withdrawal and the prerequisite gate failed
  the `up` withholding test and the prerequisite test.
- `tests/activation-gates.test.ts` (12): real runtime, lifecycle, effects and file
  state over a scripted supervisor, a recording router, and controlled port and
  listener evidence. Replacement withheld while unverified, `/apix` not the
  api's; non-local replacement stopped and withheld, sibling intact; failed
  withdrawal starts nothing; explicit `up` withholds a stopped Service;
  unknown and non-local on first `up` publish nothing; foreign answer is
  `unready`; silence is `unanswered` and a late answer publishes nothing;
  running prerequisite re-verified; portless Service on liveness in a Project
  that routes nothing; exit-0 `no` prerequisite does not satisfy a dependency;
  failed publication stops the replacement and keeps it withheld.
- `tests/providers-listener-inspection.test.ts` (19): real children listening on
  127.0.0.1, ::1 and the wildcard as a descendant of the owned shell; a foreign
  listener is not reported; idle and vanished processes; scripted `ps`/`lsof`
  failures are `unknown`; the loopback table; the port probe on both families.
- `tests/providers-caddy.test.ts`: real Caddy serves a route map (slash boundary,
  unchanged path), answers 503 for a withheld path while `/` and another site
  keep working; rendering and `ROUTE_INVALID` cases.
- `tests/config.test.ts`: several named ports, a portless Service, the legacy
  assigned-port key, and the longest-first route map replace the pinned
  "several ports" refusal.
- `tests/deployment-e2e.test.ts` runs the real inspection (`ps`/`lsof`) inside a
  real `rigd` against a real listening Service. Its Preview fixture declared a
  port it never listened on, which is now rightly not ready; it is portless now.
- `bun run typecheck`, `bun run build`: clean. Full `bun test`: see the PR body.

## Review (Codex, gpt-6-astra, high, read-only)

**Round 1** (on 8862756): four findings, all taken in narrowed form.

1. Blocker: a sibling's recovery published the whole map with only itself
   withheld, reopening the path of a Service whose replacement failed the gate
   and could not be stopped. Shapes compared: (a) the lifecycle derives the
   withheld set from recorded Service outcomes on every publish: the lifecycle
   has no store, and an outcome is not the same fact as "this path is at 503";
   (b) chosen: the published route is the record. `Router.withheld(key)` reads
   it back, `effects.route(target, {withhold} | {verified})` computes
   (published ∪ withhold) − verified. `up` names the Services it started and
   the prerequisites it gated; `recover` names its Service and the
   prerequisites it gated. Regression: an unstoppable non-local api, then web
   recovers, `/api` stays at 503 until the api itself passes on `up`. Red
   confirmed by ignoring the published state.
2. Blocker: a withdrawal identical to the file skipped the reload, although
   Caddy can serve something older than the file after a failed reload. A
   request with a withheld path now always validates and reloads.
3. Should-fix: the liveness observation inside `awaitActivation` was not raced
   against the deadline. It is now; red confirmed (the test hung to its 5 s
   limit without the race).
4. Should-fix: `/api` and `/api/` normalized to duplicate routes and `//` to an
   empty prefix. Both are refused at the field when the config is read.

Declined as scope: continuous containment, an interface redesign, #241 retry
classification, bounding the pre-existing liveness grace period.

## Handoff

- **#243**: nothing here depends on it.
- **#244**: a migrated plan has `port`/`proxy.upstream` only; `declaredPorts` and
  `plannedRoutes` read it as one port and one `/` route, and its assigned-port
  key `<service>` is honoured for the first port. Migrated Services without a
  `ready` check now need their declared port to accept connections.
- **#245** gate: the real-process evidence is `tests/providers-listener-inspection.test.ts`,
  the real-Caddy route-map smoke, and `tests/deployment-e2e.test.ts`.
