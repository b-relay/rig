---
status: proposed
---

# A deploy keeps a Target's paths up while its Services restart

One plan in two parts, for the owner to approve before any code: the **tail rule** (1.1.0), then **rollovers** of a whole Target (a later minor). Rollovers fall back on the tail rule and do not change it, so the plan can stop after the tail rule's slices.

The owner has decided: the tail rule on both sides, 1.1.0, the name `servedAt`, and that a late failure rolls back. "Tail" stays internal, out of user-facing text and CONTEXT.md.

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

The 1.0.2 fix for #725 stops the false restart, so this is no longer every Melody deploy. It remains whenever `search` really restarts along with `api` or `web`: both changed in one deploy, `--force`, `rig restart`, a Mac restart. A change to `search` alone already costs no 503, because ADR 0016 keeps `api` and `web`. Fletcher is worse on the stop side. Its schedulers have `stop_timeout: 25m` and `2m` and no `watch`, so every deploy can answer 503 for up to 27 minutes while `web` runs.

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

A rollover deploy starts the whole new version beside the old one and switches routes once, only when every Service of the new version is healthy, including ones no route needs. Until then the old version keeps serving, untouched. If anything fails its check, the new copies stop and the route never changed. **A rollover deploy has no late failure and no second rollback step:** nothing new is served until everything is verified, and after the switch the deploy is decided. The owner chose this over rolling each Service on its own. Only a deploy can roll over: `rig restart`, a Mac restart and `rig up` have no new plan, or no old version to keep serving.

1. Build and make the keep decision, as today. A Service this deploy leaves unchanged is kept and shared by both versions ([ADR 0016](0016-keep-unchanged-services.md)).
2. Start a new copy of every changed Service, in plan order, each passing its start check and its listener check on its own port. The route does not change.
3. Verify all of them again and install Tools.
4. Publish once, which sets `servedAt`, and commit.
5. After the drain, stop the old copies, dependents first, and any Service the new plan dropped.

After step 4 a new copy that exits is an ordinary crash, handled by restart policy. An old copy that will not stop is a warning on the deploy line and is retried, not a failed deploy. While the wait runs, the operation holds the Target, so the guard above watches old copies and kept Services: one that exits has its paths withheld and the wait goes on, so those paths answer 503 until the switch.

**Simpler** than rolling each Service: one flip, no tail inside the deploy, and no version mix or rollback after the switch. **Costlier:** every changed Service runs twice for as long as the new version takes to start, one Service after another.

### The stateful problem

Two copies of `db` or `search` cannot share one data directory. On Melody's usual code-only deploy that does not arise, because both are kept and shared. When one of them itself changes, there are three options:

| Option                                                             | What happens                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fall back to the tail rule, with a clear message (recommended)** | The deploy works as an ordinary restart: a short outage, then `search` loads last with the site up. Nothing new to learn or remember                                                              |
| Refuse without a flag                                              | Blocks the dashboard's rollback, an ordinary deploy that must not be refused in an incident, and the flag soon gets passed by habit                                                               |
| Restart it first, while the old version serves                     | Stop old `search`, start new, wait until healthy, then roll over the rest. No 503, but the old version is no longer untouched, and a later failure of new `api` means restarting old `search` too |

Restarting first is worth being honest about, because it nearly works for `search`. Melody's API falls back to Postgres when Typesense does not answer (`services/api/src/server.ts`), so for about 6 minutes the site stays up with slower, poorer search, each search possibly waiting out its Typesense timeout, while the old API talks to a `search` it was not deployed with. A Project without that fallback shows errors for those minutes, and Rig cannot tell which kind it has. For `db` it does not work at all: the old code loses its database, every request fails, and that is no better than a 503. It could be added later for Services nothing depends on. Until then Melody can deploy a `search` change alone, which already costs no 503 because `api` and `web` are kept, and then deploy its code.

### Which Services can have a second copy

Rig infers this from ports, with no list to maintain. A changed Service can have a second copy only if it has at least one port and every port is `auto`. Otherwise that deploy falls back.

- **A pinned port** cannot be held twice, as the owner agreed. Fletcher's comment shows why Rig must not move one: "Bookmarks and local observers use these ports".
- **No port** means a background worker, and running two is often exactly the hazard: Fletcher's schedulers would spend their search quota twice, and Vitals' recorder would write every sample twice.
- **`${rig.data}` does not decide it.** Melody's `api` uses it for a cover cache that is safe to share.
- **A Service new to the plan** has no old copy, so it may pin a port or have none.

The gap is a data owner on an `auto` port, such as pantry's `db`. Rig would start a second Postgres on the same directory. Postgres's own lock should refuse that (not tried), which fails the deploy with nothing interrupted, but other software may not refuse. So the setting's documentation says to pin the port of whatever owns data.

**What the user sees.** Before anything stops: `melody stable: not rolling over: web pins port 3400; its paths answer 503 while it restarts`. The deploy line and Activity repeat the reason, which is one of: a pinned port, no port, `--force`, or no old version running. `rig doctor` names a Project that has opted in with a routed Service that pins a port, since it would never roll over.

### Ports and traffic between Services

A Deployment's plan is already a generation. The candidate's plan records a fresh `auto` port for each changed Service, and `${port}`, `${services.api.port}`, the health check and the route all resolve from it.

- **Ports are chosen before the build,** from a first keep decision, because a build can write a port into its output: pantry's `web` build uses `${services.server.port}`. If the final decision restarts a Service that got no new port, that deploy falls back.
- **Restarts spread along port references** as they do along `depends_on`: whatever holds a moving port must have a new copy too. A Project-level `environment` naming a moving port puts it in every Service. Melody's names only `db` and `search`, which do not move.
- **A number copied into an env file** is invisible to Rig and breaks at the first rollover.

Old `web` calls old `api` and new `web` calls new `api` for the whole wait, because each resolved its own plan. Versions cross only through a public hostname or a page loaded before the switch, as after any deploy today. Both versions share kept Services, including `db`'s connection limit.

Rejected: a Caddy listener on the pinned port in front of a private one (every start runs privately, Caddy joins internal traffic, HTTP only); alternating between a pinned and a private port (it breaks the promise half the time); `SO_REUSEPORT` (the application must ask for it).

### Opting in

A Project-level setting, off by default, that a role can patch as it patches `domain`, with working name `rollover: true`. Not per Service, because the whole version decides together. A Preview can turn it off to save memory, and a working Target never deploys. The candidate's `rig.yaml` decides, so a Commit with a breaking migration turns it off in that Commit.

It cannot be inferred, because Rig cannot see the main thing it promises. Pantry's `server` migrates on every start, and Melody's `api` before it listens, while the old code goes on serving for the **whole wait**, potentially minutes: Melody's `api` has `start_period: 30m`, and its `rig.yaml` estimates its largest migration so far at 3 to 10 minutes.

- **Every migration must work with the old code for that whole window** (expand first, remove later), or that Commit turns the setting off.
- **"Users never noticed" holds only then.** A failed new version leaves the old code on a migrated database, and any table lock a migration takes blocks real requests instead of a 503.
- **Old and new code run together.** Anything else they share (a cache, files, a queue) must tolerate that too.

### Projects on this Mac

From each `rig.yaml`, read-only. None of them changes unless it opts in.

| Project  | A usual deploy restarts                 | Qualifies                                                   | What it would have to change                                                                                                                           |
| -------- | --------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| melody   | `api`, `web` (`watch` keeps the others) | Yes, after the change                                       | `ports: { http: auto }` on `api` and `web`, once nothing outside `rig.yaml` needs 3400 or 3401, and the setting. A changed `db` or `search` falls back |
| pantry   | all three (no `watch`)                  | Yes, after the change                                       | `watch` on `db` so a code deploy keeps it, a pinned port on `db`, and the setting. `server`'s migrations must follow the rule above                    |
| vitals   | `recorder`, `web` (no `watch`)          | Only for a deploy that keeps `recorder`, which has no port  | `watch` on `recorder`, narrow enough to keep it; both run one binary, so few deploys would qualify                                                     |
| podcast  | `web`                                   | By config, yes; it should not without its owner's judgement | Only the setting, but two copies would share its database and uploads, and every start migrates and imports                                            |
| share    | `server`, `explorer` (no `watch`)       | No                                                          | Unpin 8787, and decide whether two `server`s may share its store and audit log                                                                         |
| fletcher | all four (no `watch`)                   | No                                                          | Give up 4187 and 4188, which its bookmarks use, and `watch` on the schedulers, which have no port. The tail rule is its fix                            |
| rig      | Previews only (`stable: false`)         | Not needed                                                  | Nothing                                                                                                                                                |

Melody is the case worth doing first.

### Two whole versions in the records

A process key is `<target id>:<service>`, and a lease, capture request and exit records all derive from it, so a second key gets its own with no new provider capability. A key cannot be renamed while its process runs, so a new copy keeps its key for life, and the next rollover alternates back. `ServiceRun` records its key, and one function answers it, in place of the template built about 20 times across `lifecycle.ts`, `supervision.ts` and `target-effects.ts`. `recovery` names each old key and incarnation before the first spawn. An older rigd would look under the wrong key and lose a process, so this is state version 11.

**rigd dies with two versions running.** Today's answer, `rig down`, would stop a healthy site for nothing. Here the route file says who won, so the next rigd's first pass settles it without being asked, once Caddy confirms what it serves:

- **The route names the old ports:** stop the new copies, put back the previous record, and record in Activity that the deploy was interrupted and the old version kept serving.
- **The route names the new ports:** finish the commit and stop the old copies.
- **Already committed:** the record names the old copies still to retire, and the pass stops them.
- **After a Mac restart** every copy is gone: the Target settles the same way, then starts from that plan as after any Mac restart.

A deploy that fell back keeps the tail rule's recovery. A Caddy that does not answer, or a process that cannot be observed, decides nothing until a later pass.

### During the wait

- **`rig status` and the dashboard.** The candidate is already the Target's record, so they must say so plainly: `serving main@83496f8, starting main@470a510: web starting, api healthy`, showing both copies of a Service. Status JSON gains this additively.
- **`rig logs`.** Both copies write under the Service's name, as Services already share `target.jsonl`, each line tagged with its Commit, which the capture request carries. `--service` is unchanged. Capture wrappers need no other change.
- **`rig monitor`.** One series per Service, summing both copies, so the overlap shows as what it costs.
- **Jobs.** No scheduled run starts during the wait, as during any deploy, so a time that falls in a long wait is missed and not caught up. The first run after the switch uses the new plan. A run already going keeps the old version's environment and fails if it calls an old copy's port after that copy stops, a port that never comes back. Melody's `db-backup` takes `API_PORT` this way.
- **Tools** install at step 3, under the existing checkpoint, so a failure restores them and the route never moved. Superseded Tools retire at the commit.
- **Receipts.** A rollover that succeeds is `deployed`, with `servedAt` at the switch. One that fails is `failed` with no `servedAt`, and Activity says the new copies stopped and the old version kept serving. The record says whether a deploy rolled over and why not. A failed deploy carries `servedAt` only when it fell back to the tail rule.

### Route and Caddy

One publish per deploy, against three for a restart. A probe on this Host's Caddy 2.10.2, on high ports with a private socket, gave:

- A `POST /load` returned in 1 to 9 ms and did not wait for traffic. A request made right after it reached the new upstream.
- A request in flight (6 s, over HTTPS) and a 6 s streamed response both finished normally on the old upstream.
- 16 clients through one load a second for 12 s: 185,590 answers of 200 and no other status. 4 HTTPS requests failed with a closed socket, from a client that does not retry; 0 of the 93,835 over HTTP did. This is close to seamless, not perfectly so, and any publish today does the same.
- A WebSocket is closed (1001) by every load, even one that adds an unrelated site. That already happens on any route change on the Host ([#762](https://github.com/b-relay/rig/issues/762)), and a rollover does not avoid it.

**Drain.** Caddy cannot say when an old upstream is idle: `/reverse_proxy/upstreams` forgets it as soon as the load returns, with its request still in flight. So Rig waits a fixed 5 s, then stops the old copy within its `stop_timeout`. A longer request depends on how the application handles SIGTERM, as it does today; Melody's `web` exited with status 143 in #725, so that may cut it. The 5 s is a starting number, not a measured one.

### Cost

Memory is the new cost: every changed Service twice, from its new copy's start until the old copy stops. For Melody's usual deploy that is `api` and `web` for about 30 s. The worst case is its budgets added together, `api`'s 30 minutes and `web`'s 2, which is longer than the 15 minutes of `search`, since `search` never gets a second copy. Builds are unaffected: they already run beside the old version ([ADR 0004](0004-builds-belong-to-deployments.md)). The CPU of each start is what it is today, plus what the old copies serve meanwhile, so on b-mini, which overheats, this adds memory pressure more than heat. No build or test process is added. Nothing here was measured, and `rig monitor` will show it on the first real rollover.

### Does this still build on the tail rule?

Yes, and the approved order still holds, with one thing to weigh.

- **Rollovers need from it:** the fallback for every deploy that cannot roll over, the guard, the recovery duty and `servedAt`.
- **Rollovers do not use:** its publication point or its stop side, because a rollover deploy has no tail.
- **It is not made unnecessary.** `rig restart`, a Mac restart, `rig up`, a changed `db` or `search`, and every Project that has not opted in, including all of Fletcher's deploys, can never roll over.
- **To weigh:** on Melody's usual code-only deploy the tail rule changes nothing and rollovers remove all of it, so rollovers are what the owner will feel most often. But without the tail rule, a deploy that falls back still costs 6m51s. So the tail rule still goes first.

The earlier approval of holding old copies and rolling back a late failure maps like this: a rollover deploy holds old copies by construction and has no late failure, and a deploy that falls back rolls back a late failure as the tail rule says, with no old copies to hold. The earlier design's hold through the tail and publish-back step are gone.

### What each deploy costs

Worked out from the #725 log and each `rig.yaml`: none of these was measured, and no rollover has run. Outage means 503s. The rollover column assumes Melody has made its change.

| Deploy                                                           | Today                                 | Tail rule                                                 | Rollovers on                               | Two copies               |
| ---------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------- | ------------------------------------------ | ------------------------ |
| Melody, code only                                                | about 30 s                            | about 30 s                                                | about 0                                    | `api`, `web`, about 30 s |
| Melody, code only, new version fails                             | about 1 min, up to the check's budget | the same                                                  | 0 (see migrations)                         | until the check fails    |
| Melody, `search` change alone                                    | 0; `search` absent about 6 min        | the same                                                  | the same (falls back)                      | none                     |
| Melody, code and `search` together                               | about 6m50s                           | about 30 s; `search` absent about 6 min                   | the same (falls back), or 0 as two deploys | none                     |
| Melody, `db` changes (#725's shape)                              | 6m51s                                 | 32 s                                                      | 32 s (falls back)                          | none                     |
| Melody, `rig restart`                                            | 6m51s                                 | 32 s                                                      | 32 s (never rolls over)                    | none                     |
| Fletcher, every deploy as configured                             | up to 27 min, plus `web`'s start      | `web`'s stop and start, at most its 30 s check, not timed | the same (does not qualify)                | none                     |
| Fletcher, web-only, after giving up its ports and adding `watch` | as above                              | as above                                                  | about 0                                    | `web`, up to 30 s        |

## Open questions for the owner

Decided: the order (tail rule in 1.1.0, rollovers in a later minor), all-or-nothing rollovers at the Target level, no rollover where a changed Service pins a port, and rolling back a late failure.

1. **The setting: Project-level with a role patch, and what name?** Recommendation: `rollover: true`, off by default. It cannot be inferred, because Rig cannot see whether migrations work with the old code.
2. **When a stateful Service changes: fall back or refuse?** Recommendation: fall back to the tail rule with a clear message before anything stops, and no flag. The deploy then has a short outage the owner did not explicitly accept. Refusing would block the dashboard's rollback in an incident. Restarting `search` first can come later.
3. **Decide who gets a second copy from ports alone: every port `auto`?** Recommendation: yes, with no list of Services. The cost is that a data owner on an `auto` port, such as pantry's `db`, must be pinned by hand. The alternative is a list in the setting, which is safer against that one mistake but is one more thing to maintain and to get wrong.

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

Slices 6 and 7 change no behaviour for any Project, so they can land early. Slice 8 onwards needs the tail rule's fallback and guard. The setting is off until slice 10 lands.

6. **One function for a Service's process key,** read from its run. Tests: the existing suite unchanged; a run recorded under the second key is observed, stopped and supervised under it.
7. **Two versions in the records:** `recovery` names the old keys, and state version 11. Tests: a version 10 state reads; `rig down` and `stopForRecovery` stop every key named, route first.
8. **The setting, eligibility, port choice and spreading along references.** Pure where it can be. Tests: each Project shape in the table decides as it says; a changed pinned or portless Service falls back with its reason before anything stops; a new pinned Service does not; a port reference spreads a restart; pantry's build sees the new port; a kept Service does not move.
9. **The sequence.** Tests: the route is unchanged until every new copy, one no route needs included, is verified; a copy that fails leaves the old version unsignalled and the route untouched, with no `servedAt`; a failed Tool does the same; an old copy that exits during the wait is withheld and the wait goes on; an old copy that will not stop leaves the deploy `deployed` with a warning. One live Caddy test: continuous requests through a rollover, every answer 200, and a slow request finishing on the old copy.
10. **Settling after a crash.** Tests: rigd killed at each step settles from the route, old or new, with no `rig down`; a commit with old copies left retires them; a Mac restart settles and starts; a Caddy that does not answer decides nothing.
11. **Reports:** status, the dashboard, tagged log lines, the Monitor's summed series, the deploy line and Activity, `rig doctor`'s note and the docs, including the migration rule. Tests: both copies sum into one series; status names what is serving and what is starting; each fallback reason is shown.

On acceptance, CONTEXT.md's route relationship needs no change: "from its verified start until just before it stops" is what the tail rule makes true. Rollovers add one term to CONTEXT.md, once the setting's name is chosen.

Claude Opus 5.5 on behalf of Brendon
