---
status: proposed
---

# A deploy keeps a Target's paths up while its Services restart

One plan in two parts, for the owner to approve before any code: the **tail rule** (1.1.0), then **rollovers** (a later minor). Rollovers build on the tail rule and do not change it, so either can stop after its own slices.

The owner has decided: the tail rule on both sides, 1.1.0, and the name `servedAt`. "Tail" stays internal, out of user-facing text and CONTEXT.md. Rolling back on a tail Service's late failure is the working answer, and [Rollovers](#rollovers) says what they change about it.

## Problem

A deploy that really restarts a slow Service takes the whole site down for that Service's full stop and start, even when no path reaches it ([#726](https://github.com/b-relay/rig/issues/726)). `lifecycle.down` withholds every path before anything stops, and `lifecycle.up` publishes only after the last Service is verified.

The [#725](https://github.com/b-relay/rig/issues/725) incident on Melody, whose plan is `db, api, web, search`:

| Part of the outage                                    | From → to           | Length |
| ----------------------------------------------------- | ------------------- | ------ |
| `search` stops; `web` and `api` run, but are withheld | 15:23:35 → 15:24:36 | 61 s   |
| `web`, `api`, `db` stop and start                     | 15:24:36 → 15:25:08 | 32 s   |
| `search` loads, then the last checks and the publish  | 15:25:08 → 15:30:26 | 5m18s  |
| **Total**                                             |                     | 6m51s  |

Melody's `rig.yaml` already says what it expects: "`search` comes last on purpose ... so the site is up first". Rig does not do that.

The 1.0.2 fix for #725 stops the false restart, so this is no longer every Melody deploy. It remains every real restart of `search`: a changed definition, `--force`, `rig restart`, a Mac restart. Fletcher is worse on the stop side. Its schedulers have `stop_timeout: 25m` and `2m` and no `watch`, so every deploy can answer 503 for up to 27 minutes while `web` runs.

[#242](https://github.com/b-relay/rig/issues/242) does not require all-at-end. It requires that a path reach only a verified activation. That a failed start served nothing new is a consequence of the implementation, though the guide does promise it ("before anything is published").

## The tail rule

### The tail

A stop or start acts on a list of Services in plan order. Its **tail** is the longest run at the end of that list in which no Service has a path, and none depends, directly or transitively, on a Service that has one. A plan with no paths has no tail. A Service the start finds already running (a kept one) is not in the list.

Dependency order puts everything a routed Service `depends_on` before it, so nothing a path declares a need for can be in the tail. The second condition is there for Share, whose `server` calls `explorer` while `explorer` `depends_on: [server]`. They cannot be reordered, and without that condition `/` would break for up to a minute of each restart.

| Project                      | Plan                                                          | Tail                                  | Effect                        |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------- | ----------------------------- |
| melody                       | `db, api, web, search`                                        | `search`                              | 6m51s becomes 32 s            |
| fletcher                     | `comparison-refresh, web, google-scheduler, points-scheduler` | both schedulers                       | up to 27 min less on the stop |
| share                        | `server, explorer`                                            | none (`explorer` depends on `server`) | unchanged                     |
| pantry, vitals, podcast, rig | all needed, or one Service                                    | none                                  | unchanged                     |

A Project with no tail gets exactly today's sequence of stops, starts and publishes.

### Start: publish before the tail

This applies to every `lifecycle.up`, so a Mac restart and `rig up` gain it too.

1. Withhold the paths of stopped Services (as today).
2. Start the Services before the tail, in plan order, each passing its start check (as today).
3. Install Tools. They move ahead of the tail, so a failure that need not follow publication does not.
4. Verify those Services again and publish every path in one change (today's checks, earlier).
5. Start the tail in plan order, under the guard.
6. Verify everything again and finish. The deploy commits only here.

Rig never reorders Services. All paths still flip together, so `melody.b-relay.com` and `api.melody.b-relay.com` change as one.

### Stop: the tail goes first when something replaces it

The stop order does not change: reverse plan order already stops the tail first. Only the withhold moves, from before the first stop to before the first Service outside the tail. It is still one change, and the rule that a path is withheld before its Service stops still holds.

This mode is used only by a deploy's stop of the previous Deployment and by `rig restart`, where the site is expected back. Everything else withholds up front as today: plain `rig down` and `--kill`, `deploy --no-up`, Preview stop and destroy, `forget`, a reconcile pass, a recovery stop, and every rollback. `rig down` may be incident response, has no successor, and must not keep serving through a stop that can last up to an hour.

### The guard

Automatic restart passes skip a Target an operation holds ([ADR 0007](0007-per-target-operation-queue.md)), and the health monitor skips one with a pending `recovery`. Today that blind spot only covers kept Services. With live paths through a tail it would cover the site for minutes, and a freed port with a live path breaks the rule that a program taking that port never receives its requests.

So while the tail stops or starts, the operation observes every Service with a live path once a second. One that exited has its paths withheld at once, as supervision would. If this start started it, the start fails and rolls back, as a failed re-verification does today. Otherwise (kept, or about to be replaced) the operation carries on, and restart policy deals with a kept Service after the commit. A health check that goes bad but leaves the process running is caught by step 6, not sooner.

### What the tail rule answers

**A failed deploy after the route served the new version.** It rolls back to the previous Deployment. `up`'s failure path withholds what it started, stops it, and the deploy restores and starts the previous plan. No new state and no new code path. What changes is what Rig says:

- **The error and Activity** say the new Commit was served, from when and for how long. The hint "nothing of this start was published" is shown only when true.
- **`DeploymentRecord`** gains an optional `servedAt`, so the dashboard's history can show it. An optional field needs no state version (see the note on `STATE_VERSION`).
- **`rig status`** during the tail shows the deploy in progress as it does now, with paths live, read from the route block as it already is. After a rollback it shows the previous Commit.

Serving code that is then rolled back is new, but smaller than it looks. `api` already runs migrations before it listens, so a rollback today already returns to old code on a migrated database. What is added is data users wrote through the new code in that window, which old code must then read. That is the same exposure as the dashboard's rollback. Only Projects with a tail are exposed, and only when a tail Service fails. A Project that will not accept it moves that Service above its last routed Service.

Rollback also gets much cheaper. If Melody's `search` fails at its 15-minute `start_period`, today the site answers 503 for about 23 minutes without a break. With this, about 2 minutes in two parts (32 s, then up to 1m32s), with the new version serving in between. Both are worked out, not measured.

**Order.** A Service that `depends_on` a slower one waits for it, and so do all paths: the slower one is ahead of it. A Service an app reaches without declaring it is safe when listed above the last routed Service, as serial start already gates it. Listed below, it is the tail, and the app runs without it for the tail's stop and start. That is the real risk of this change. It is bounded by the tail's stop and start time, and the Project fixes it with `depends_on` or by moving a line. Position in `rig.yaml` already decides what starts first, and now it also decides what the site waits for, which is what Melody's comment assumes. Reordering automatically, as the issue suggests, would break a `redis` listed first with no `depends_on`, at start and not only in routing.

**Default, no knob, 1.1.0.** Order is already the setting, so a key would say the same thing twice and split the tested behaviour in two. Nothing in `rig.yaml` needs to change, and five of the seven Projects here see no difference. The documented "before anything is published" narrows, and a Project with an undeclared need on its tail sees errors where it saw 503s; the release note says so.

**Kept Services (ADR 0016).** No change: a kept Service's path is never withheld. A kept Service is not in the list, so `web` kept with `api` and `search` restarting gives `search` as the tail. If only tail Services restart, nothing is withheld at all, as today. A port a deploy newly gives a kept Service is published at step 4 once its process is found listening. Rollback leaves untouched kept Services alone as today.

**Old and new versions.** No different from today. Everything outside the tail restarts inside one withheld window and is published together, so a new `web` never reaches an old `api`, unless `api` is kept, which ADR 0016 already accepts as "unchanged means equivalent". The only new overlaps are old code with its tail stopping and new code with its tail loading, which are the tail being absent rather than a version mix. Per-path publication would add new `web` against a stopped `api`.

**Stopping.** A tail Service that fails to stop is collected as today, and the rest still stop. A withhold that fails after the tail stopped takes the existing `ROUTE_WITHHOLD` path, which already ends in `DEPLOY_ROLLBACK_BLOCKED`; only its wording "nothing was stopped" becomes "no Service with a path was stopped".

**Other Targets and cost.** Previews and working Targets use the same `lifecycle.up` and the same rule. A Target with no route has no tail. The dashboard's hostname is rigd's own route and is untouched. Melody makes the same three publishes as today (withhold, start's withhold, publish), so there is no reload per Service.

**Crash recovery.** Publishing is journalled by `withRouteChange` as it is today, and `stopForRecovery` already withholds everything and stops both plans, so no new record is needed.

- **rigd dies during the tail (start or stop).** Services keep running and `recovery` stays pending. The next rigd restarts Caddy from `current`, which holds the live paths. The site keeps serving until someone runs `rig down`, where today it would answer 503. `rig up` and `rig deploy` are still refused with `DEPLOY_RECOVERY`.
- **A gap this widens.** rigd's pass returns early for a Target with a pending `recovery`, so a live path to a Service that exits stays live, and after a Mac restart Caddy starts with paths to dead ports. The Host restart fixes in #745 and #751 left this case to this design. It exists today for kept Services' paths, and it becomes the common case. So the pass gains one duty for such a Target, in the manner of `withholdStoppedServices`: observe each Service with a live path and withhold those seen stopped. It restarts nothing, and an unanswered observation decides nothing until a later pass.
- **A Target with no `recovery`** (`rig up`, `rig restart`, a Mac restart) behaves as today: desired state decides whether the next pass supervises or stops it, and #745 and #751 withhold the paths of Services seen stopped.

### Alternatives to the tail rule

Melody's #725 outage was 6m51s. All figures are worked out from that log.

| Option                                                           | Left  | Removed | Risk added                                                                                 |
| ---------------------------------------------------------------- | ----- | ------- | ------------------------------------------------------------------------------------------ |
| Rely on the 1.0.2 fix alone                                      | 6m51s | 0       | None; every real restart stays as it is                                                    |
| Stop side only                                                   | 5m50s | 15%     | Low: only old code keeps serving. But removes up to 27 min for Fletcher                    |
| Start side only                                                  | 1m33s | 77%     | Medium: served then rolled back; the guard; crash recovery                                 |
| **Tail on both sides (decided)**                                 | 32 s  | 92%     | Medium: as above, only for Projects with a tail                                            |
| Per-path both sides (the issue's candidate)                      | ~32 s | 92%     | Higher: every multi-path Project gets partial publication and version gaps; 2k+1 publishes |
| Exclude every unrouted Service from the wait, starting them last | 1m33s | 77%     | Higher: reordering breaks undeclared prerequisites at start; Share's `/` breaks            |
| Commit at site-up, tail in the background, with the stop side    | 32 s  | 92%     | High: success no longer means verified; a bad `search` config leaves nothing restored      |

Per-path would help one case the tail does not: a slow routed Service in the middle, such as `/admin`. No Project here has one, and it can be added later without undoing this.

## Rollovers

A rollover starts a Service's new instance beside the old one, waits until it passes its start check, switches the route, then stops the old one. It is feasible for stateless routed Services and not for `db` or `search`. Only a deploy rolls over: `rig restart`, a health restart and a crash restart have no new plan and, for the last two, nothing to replace.

### Which Services: a key, because inference is not safe

The `rig.yaml` files on this Mac show that `${rig.data}` does not decide it:

| Service         | `${rig.data}`                                                         | What Rig cannot see                         |
| --------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| melody `web`    | no                                                                    | Nothing known against it                    |
| melody `api`    | yes: a cover cache, safe to share                                     | Runs migrations before it listens           |
| pantry `server` | no                                                                    | Migrates on every start                     |
| vitals `web`    | no, but reads the recorder's SQLite through another Service's setting | That it only reads                          |
| podcast `web`   | yes: its database and uploads                                         | Migrates and imports content on every start |
| share `server`  | yes: its store and audit log                                          | Whether two copies may share them           |
| fletcher `web`  | yes: a SQLite index                                                   | Whether two copies may share it             |

The check would block `api`, which is safe, and pass pantry's `server`, which migrates. A `command` is shell, so Rig cannot see an in-process schedule or a lock either. So a Service opts in with a key, working name `rollover: true`, which says two copies may run together for a moment. Without it nothing changes. Rig refuses at parse only what it can prove: the key on a Service with a pinned port.

A deploy rolls over only when every restarting Service outside the tail has the key. Otherwise the whole deploy uses the tail rule, and its line says why. A `db` that must stop is an outage for its dependents anyway, so a partial rollover buys nothing. The candidate's `rig.yaml` decides, so a Commit with a breaking migration turns the key off in that Commit.

### Ports: the new plan gets a new port

A Deployment's plan is already a generation. The candidate's plan records a fresh `auto` port for each rolling Service, and `${port}`, `${services.api.port}`, the health check and the route all resolve from it. The old instance keeps the previous plan's port until it stops.

- **A pinned port blocks a rollover.** It is a promise outside Rig. Fletcher's says so: "Bookmarks and local observers use these ports". Melody's `web` (3400) and `api` (3401) are referenced in `rig.yaml` only through `${services...}`, so `ports: { http: auto }` is its one-line change. Anything else that knows those numbers must be checked first.
- **Ports are chosen once, before the build,** from a first keep decision, because a build can write a port into its output: pantry's `web` build uses `${services.server.port}`. A Service the first decision keeps does not move. If the final decision restarts a Service that got no new port, that deploy uses the tail rule.
- **Restarts spread along port references** as they do along `depends_on`: whatever holds `${services.api.port}` in a command, environment or build must move too. A holder without the key means the tail rule. A Project-level `environment` naming a port would put it in every Service, so it blocks rollovers. Melody's names only `db` and `search`, which do not move.
- **A number copied into an env file** is invisible to Rig and breaks at the first rollover. The key's documentation says so.

Rejected: a Caddy listener on the pinned port in front of a private one, since every start then runs privately, Caddy joins internal traffic, and only HTTP works. Alternating between the pinned port and a private one, since it breaks the promise half the time. `SO_REUSEPORT`, since the application would have to ask for it.

### Service-to-Service traffic

Generations do not cross. Old `web` holds old `api`'s port and new `web` holds new `api`'s, because each resolved its references from its own plan. Old instances stop dependents first, so old `web`'s calls finish on old `api`. Crossing happens only through a public hostname or a page loaded before the switch: an old page calling `api.melody.b-relay.com` reaches new `api`, as it does after any deploy today. Both generations share `db` and other kept Services, so they also share its connection limit.

### The sequence

1. Start the new instances of the Services outside the tail, in plan order, each passing its start check, including the listener check on its own port. The route does not change.
2. Install Tools and verify the new instances again.
3. Publish once: every path moves to the new ports. `servedAt` is set here.
4. Stop the old tail and start the new tail, under the guard. The old instances stay running, unrouted.
5. Verify everything again.
6. After the drain, stop the old instances, dependents first, then commit.

### Route and Caddy

One publish per deploy, not per Service: fewer than the three a restart makes. A probe on this Host's Caddy 2.10.2, on high ports with a private socket, gave:

- A `POST /load` returned in 1 to 9 ms and did not wait for traffic. A request made right after it reached the new upstream.
- A request in flight (6 s, over HTTPS) and a 6 s streamed response both finished normally on the old upstream.
- 16 clients through one load a second for 12 s: 185,590 answers of 200 and no other status. 4 HTTPS requests failed with a closed socket, from a client that does not retry; 0 of the 93,835 over HTTP did. This is close to seamless, not perfectly so, and any publish today does the same.
- A WebSocket is closed (1001) by every load, even one that adds an unrelated site. That already happens on any route change on the Host ([#762](https://github.com/b-relay/rig/issues/762)), and a rollover does not avoid it.

**Drain.** Caddy cannot say when an old upstream is idle: `/reverse_proxy/upstreams` forgets it as soon as the load returns, while its request is still in flight. So Rig waits a fixed 5 s after the publish, or the time step 4 took if longer, then stops the old instance within its `stop_timeout`. A longer request then depends on how the application handles SIGTERM, as it does today. Melody's `web` exited with status 143 in #725, so that may cut it. The 5 s is a starting number, not a measured one.

### Failure

| It fails at                   | Traffic                            | Rollback                                                                          | Receipts                                                                    |
| ----------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Steps 1 to 3                  | Old instances serve, uninterrupted | Stop the new instances. The route never changed                                   | `failed`, no `servedAt`; Activity says the previous Deployment kept serving |
| Steps 4 and 5                 | New, then old again, with no 503   | Publish back, stop the new instances, restart the old tail                        | `failed`, `servedAt`; Activity says how long it served                      |
| Step 6: an old one won't stop | New instances serve                | As an unverified stop today: `DEPLOY_ROLLBACK_BLOCKED`, and `rig down` settles it | As above                                                                    |

This is what rollovers change about a late tail failure: rolling back stays the answer, and holding the old instances makes it one publish instead of a second outage. For Melody that holds old `web` and `api` for `search`'s load, 5 minutes usually and 15 at most. New code was still served and then reverted, so the data caveat above stands. If an old instance exited during the hold, rollback is the ordinary start of the previous plan.

### Two instances in the records

A process key is `<target id>:<service>`, and a lease, capture request and exit records all derive from the key, so a second key gets its own without any new provider capability. Capture wrappers need no change: each serves one key, and `stop` already takes an incarnation. A key cannot be renamed while its process runs, so the new instance keeps its key for life, and the next rollover alternates back.

- **`ServiceRun` records its key.** One function answers a Service's key from its run, in place of the template built about 20 times across `lifecycle.ts`, `supervision.ts` and `target-effects.ts`.
- **`recovery` names each old key and incarnation,** written before the first spawn, as `journal.starting` already records a start before it spawns. A recorded key that never spawned is simply seen stopped.
- **rigd dies with two instances running.** Both keep running and the route stays where it was, on old or new. The tail rule's recovery duty observes the Service behind each live path by its key. `rig down` withholds everything and stops every key named, as `stopForRecovery` does for both plans today.
- **State version 11.** An older rigd would look under the wrong key and lose a process, which is the case that note says needs a version.

### Limits

**Old and new code run together.** With `web` that lasts seconds. With a migration it decides safety: `api` and pantry's `server` migrate before they listen, while the old instance is still serving. So every migration must work with the code before it (expand first, remove later), or the Commit turns the key off. A long migration runs under live traffic: Melody's `rig.yaml` estimates its largest so far, 0021, at 3 to 10 minutes, and any table lock such a migration takes now blocks real requests instead of a 503. A failed new instance leaves the old one serving on a migrated database. Rig cannot detect any of this, which is the main reason for the key. `db`, `search`, or anything else that owns a data directory never rolls over.

**Cost.** Builds are unaffected: they already run beside the old Deployment ([ADR 0004](0004-builds-belong-to-deployments.md)). The added cost is the old instance's memory during the new one's start, and during a tail's load when held. The CPU of a start is the same as today plus whatever the old instance serves meanwhile, so memory, not heat, is the new cost on b-mini. It was not measured. No build or test process is added.

### Interactions

- **The tail rule** is what runs whenever a deploy cannot roll over. A rollover deploy uses the same publication point and guard, but stops its tail after the publish, since nothing needs withholding.
- **Kept Services (ADR 0016)** are not in the restart set and do not move. An old instance is held like a kept process's checkout until it stops.
- **`rig logs`.** Both instances write under the Service's name, interleaved, as Services already share `target.jsonl`. Rig adds a line each at the start of the new instance, the switch and the stop of the old. No new filter.
- **`rig monitor`.** One series per Service, summing both process trees, so the overlap shows as the real cost. No second series. `monitored-processes` lists the old instance from `recovery`.
- **Jobs.** No scheduled run starts during a deploy, as today. A run already in progress keeps the old port in its environment, and that port does not come back when the old instance stops, unlike a restart on a stable port. It fails if it calls the Service afterwards. Melody's `db-backup` takes `API_PORT` this way.
- **`rig status`** shows the deploy in progress and the plan's port. The deploy line and Activity name each Service rolled over beside `restarted`, with the same reasons.

### What it removes

Worked out from the #725 log and each `rig.yaml`; no rollover has been run. The 32 s left by the tail rule was `db` 2 s, `api` 27 s and `web` 3 s.

| Deploy                                  | With the tail rule                             | With rollovers | Needs                                                                                                                     |
| --------------------------------------- | ---------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Melody, code only (`db`, `search` kept) | about 30 s                                     | about 0        | The key and `auto` on `api` and `web`                                                                                     |
| Melody, also a real `search` restart    | about 30 s                                     | about 0        | The same; `search` loads afterwards                                                                                       |
| Melody, `db` restarts (#725's shape)    | 32 s                                           | 32 s           | Nothing helps: `db` must stop                                                                                             |
| Fletcher, as configured                 | at most 30 s of `web`'s start check, not timed | unchanged      | Dropping the pinned 4187 and 4188 its bookmarks use, and `watch` so `comparison-refresh` stays kept, or the key on it too |

So rollovers remove most of what is left on an ordinary Melody deploy, none of a `db` restart, and nothing on Fletcher unless it gives up its ports.

## Open questions for the owner

1. **Approve this plan and its order: the tail rule in 1.1.0, then rollovers in a later minor?** Recommendation: yes. They are independent, and the tail rule gives the larger gain with no change to any `rig.yaml`.
2. **Accept an opt-in key, and name it.** Inference is not safe (see above), so rollovers need one. Recommendation: `rollover: true` on the Service.
3. **Refuse the key on a pinned port?** Recommendation: yes. Melody changes `web` and `api` to `auto`, after checking nothing outside `rig.yaml` uses 3400 or 3401. Fletcher stays out. The alternative is a Caddy listener on the pinned port, which is much more to build and carry.
4. **Hold the old instances until the tail is verified, and confirm rollback as the answer to a late tail failure?** Recommendation: yes to both. A late failure then costs one publish and no outage, for the price of old instances' memory through the tail's load, up to Melody's 15 minutes.

## Implementation slices

Tests use the recording router and controlled supervisor fixtures of `tests/verified-routes.test.ts` and `tests/activation-gates.test.ts`, under an isolated `RIG_ROOT`.

### The tail rule (1.1.0)

Slices 1 and 2 can ship alone. Slices 3 and 4 ship in one release, because 3 widens the gap 4 closes.

1. **The tail, as a pure function of a plan and the Services acted on.** No behaviour change. Tests: each Project shape in the table; Share's dependent is excluded; a transitive dependent is excluded; a kept routed Service is transparent; no paths gives no tail.
2. **Stop side**, with its half of the guard and the `ROUTE_WITHHOLD` wording. Tests: with a blocked `search` stop, `/` stays live and is withheld before `web` stops; plain `rig down`, `--no-up` and Preview destroy still withhold first; a routed Service that exits during the tail's stop is withheld within a pass; a Project with no tail makes the same route calls in the same order.
3. **Start side**, with Tools moved, its half of the guard and the docs (`docs/rig-guide.md` start check, routing and start order). Tests: a pending tail start check with `/` already live; a tail failure withholds, stops and restores the previous plan and route; a published Service that exits during the tail fails the start within a pass; a publish failure stops the tail from starting; a Tool failure happens before publication; rollback's own start publishes before the previous tail. One live Caddy test in the existing e2e file: a slow tail, real requests answering through it.
4. **Recovery duty.** Tests: rigd killed mid-tail keeps paths live while Services run; an exit withholds only that path; a restart with a pending `recovery` withholds paths to dead ports; `rig down` still settles it; a failed observation withholds nothing and retries.
5. **Receipts:** `servedAt`, Activity text, the failure's hint, and the dashboard's history row. Tests: a failed deploy that served says so and one that did not does not; a state file with the field reads on the current version.

### Rollovers (a later minor)

These need the tail rule's publication point and guard, and change neither. Slices 6 and 7 change no behaviour for any Project, so they can land early.

6. **One function for a Service's process key,** read from its run. Tests: the existing suite unchanged; a run recorded under the second key is observed, stopped and supervised under it.
7. **Two instances in the records:** `recovery` names the old keys, state version 11, and `stopForRecovery` stops both. Tests: with rigd killed at each step of the sequence, `rig down` withholds first and stops both; a version 10 state reads; the recovery duty follows the key.
8. **The key, the first keep decision, port choice and spreading along references.** Pure where it can be. Tests: the key on a pinned port is refused; each Project shape decides as the tables say; a port reference spreads a restart; a holder without the key falls back; pantry's build sees the new port; a kept Service does not move.
9. **The sequence.** Tests: the route is unchanged until every new instance is verified; a new instance that fails leaves the old one unsignalled and the route untouched, with no `servedAt`; a late tail failure publishes back without stopping an old instance; old instances stop dependents first, after the drain. One live Caddy test: continuous requests through a rollover, every answer 200, and a slow request finishing on the old instance.
10. **Reports:** the deploy line, Activity, log lines, the Monitor's summed series, status and docs. Tests: both trees sum into one series; a held old instance is shown; the guide states the migration rule.

On acceptance, CONTEXT.md's route relationship needs no change: "from its verified start until just before it stops" is what the tail rule makes true. Rollovers add one term to CONTEXT.md, once its name is chosen.

Claude Opus 5.5 on behalf of Brendon
