---
status: proposed
---

# A restart keeps a Target's paths up around the Services they do not need

## Problem

A deploy that really restarts a slow Service takes the whole site down for that Service's full stop and start, even when no path reaches it ([#726](https://github.com/b-relay/rig/issues/726)). `lifecycle.down` withholds every path before anything stops, and `lifecycle.up` publishes only after the last Service is verified.

The [#725](https://github.com/b-relay/rig/issues/725) incident on Melody, whose plan is `db, api, web, search`:

| Part of the outage                                    | From → to           | Length |
| ----------------------------------------------------- | ------------------- | ------ |
| `search` stops; `web` and `api` run, but are withheld | 15:23:35 → 15:24:36 | 61 s   |
| `web`, `api`, `db` stop and start                     | 15:24:36 → 15:25:08 | 32 s   |
| `search` loads, then the last checks and the publish  | 15:25:08 → 15:30:26 | 5m18s  |
| **Total**                                             |                     | 6m51s  |

Only the middle row is needed. Melody's `rig.yaml` already says what it expects: "`search` comes last on purpose ... so the site is up first". Rig does not do that.

The 1.0.2 fix for #725 stops the false restart, so this is no longer every Melody deploy. It remains every real restart of `search`: a changed definition, `--force`, `rig restart`, a Mac restart. Fletcher is worse on the stop side. Its schedulers have `stop_timeout: 25m` and `2m` and no `watch`, so every deploy can answer 503 for up to 27 minutes while `web` runs.

[#242](https://github.com/b-relay/rig/issues/242) does not require all-at-end. It requires that a path reach only a verified activation. That a failed start served nothing new is a consequence of the implementation, though the guide does promise it ("before anything is published").

## Decision

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

## What this answers

**1. A failed deploy after the route served the new version.** It still rolls back to the previous Deployment. `up`'s failure path withholds what it started, stops it, and the deploy restores and starts the previous plan. No new state and no new code path. What changes is what Rig says:

- **The error and Activity** say the new Commit was served, from when and for how long. The hint "nothing of this start was published" is shown only when true.
- **`DeploymentRecord`** gains an optional `servedAt`, so the dashboard's history can show it. An optional field needs no state version (see the note on `STATE_VERSION`).
- **`rig status`** during the tail shows the deploy in progress as it does now, with paths live, read from the route block as it already is. After a rollback it shows the previous Commit.

Serving code that is then rolled back is new, but smaller than it looks. `api` already runs migrations before it listens, so a rollback today already returns to old code on a migrated database. What is added is data users wrote through the new code in that window, which old code must then read. That is the same exposure as the dashboard's rollback. Only Projects with a tail are exposed, and only when a tail Service fails. A Project that will not accept it moves that Service above its last routed Service.

Rollback also gets much cheaper. If Melody's `search` fails at its 15-minute `start_period`, today the site answers 503 for about 23 minutes without a break. With this, about 2 minutes in two parts (32 s, then up to 1m32s), with the new version serving in between.

**2. Order.** A Service that `depends_on` a slower one waits for it, and so do all paths: the slower one is ahead of it. A Service an app reaches without declaring it is safe when listed above the last routed Service, as serial start already gates it. Listed below, it is the tail, and the app runs without it for the tail's stop and start. That is the real risk of this change. It is bounded by the tail's stop and start time, and the Project fixes it with `depends_on` or by moving a line. Position in `rig.yaml` already decides what starts first, and now it also decides what the site waits for, which is what Melody's comment assumes. Reordering automatically, as the issue suggests, would break a `redis` listed first with no `depends_on`, at start and not only in routing.

**3. Default, no knob.** Order is already the setting, so a key would say the same thing twice and split the tested behaviour in two. Nothing in `rig.yaml` needs to change, and five of the seven Projects here see no difference. The documented "before anything is published" does change, and a Project with an undeclared need on its tail sees errors where it saw 503s. See the version question below.

**4. Kept Services (ADR 0016).** No change: a kept Service's path is never withheld. A kept Service is not in the list, so `web` kept with `api` and `search` restarting gives `search` as the tail. If only tail Services restart, nothing is withheld at all, as today. A port a deploy newly gives a kept Service is published at step 4 once its process is found listening. Rollback leaves untouched kept Services alone as today.

**5. Old and new versions.** No different from today. Everything outside the tail restarts inside one withheld window and is published together, so a new `web` never reaches an old `api`, unless `api` is kept, which ADR 0016 already accepts as "unchanged means equivalent". The only new overlaps are old code with its tail stopping and new code with its tail loading, which are the tail being absent rather than a version mix. Per-path publication would add new `web` against a stopped `api`.

**6. Stopping.** Above. A tail Service that fails to stop is collected as today, and the rest still stop. A withhold that fails after the tail stopped takes the existing `ROUTE_WITHHOLD` path, which already ends in `DEPLOY_ROLLBACK_BLOCKED`; only its wording "nothing was stopped" becomes "no Service with a path was stopped".

**7. Other Targets and cost.** Previews and working Targets use the same `lifecycle.up` and the same rule. A Target with no route has no tail. The dashboard's hostname is rigd's own route and is untouched. Melody makes the same three publishes as today (withhold, start's withhold, publish), so there is no reload per Service. On this Host's Caddy, `adapt` took about 0.05 s and `validate` 0.05 to 0.15 s for eight sites (the load itself not measured). Cost does not decide this, but per-path would add a publish per routed Service in each direction, through the Host's one queue.

**8. Crash recovery.** Publishing is journalled by `withRouteChange` as it is today, and `stopForRecovery` already withholds everything and stops both plans, so no new record is needed.

- **rigd dies during the tail (start or stop).** Services keep running and `recovery` stays pending. The next rigd restarts Caddy from `current`, which holds the live paths. The site keeps serving until someone runs `rig down`, where today it would answer 503. `rig up` and `rig deploy` are still refused with `DEPLOY_RECOVERY`.
- **A gap this widens.** A Target with a pending `recovery` is neither supervised nor monitored, so a live path to a Service that exits stays live, and after a Mac restart Caddy starts with paths to dead ports. This exists today for kept Services' paths, and it becomes the common case. So rigd's pass on such a Target gains one duty: observe each Service with a live path and withhold those that exited. It restarts nothing. Failed observations retry on the next pass.
- **A Target with no `recovery`** (`rig up`, `rig restart`, a Mac restart) behaves as today: desired state decides whether the next pass supervises or stops it.

## Alternatives

Melody's #725 outage was 6m51s.

| Option                                                           | Left  | Removed | Risk added                                                                                 |
| ---------------------------------------------------------------- | ----- | ------- | ------------------------------------------------------------------------------------------ |
| Rely on the 1.0.2 fix alone                                      | 6m51s | 0       | None; every real restart stays as it is                                                    |
| Stop side only                                                   | 5m50s | 15%     | Low: only old code keeps serving. But removes up to 27 min for Fletcher                    |
| Start side only                                                  | 1m33s | 77%     | Medium: served then rolled back; the guard; crash recovery                                 |
| **Tail on both sides (recommended)**                             | 32 s  | 92%     | Medium: as above, only for Projects with a tail                                            |
| Per-path both sides (the issue's candidate)                      | ~32 s | 92%     | Higher: every multi-path Project gets partial publication and version gaps; 2k+1 publishes |
| Exclude every unrouted Service from the wait, starting them last | 1m33s | 77%     | Higher: reordering breaks undeclared prerequisites at start; Share's `/` breaks            |
| Commit at site-up, tail in the background, with the stop side    | 32 s  | 92%     | High: success no longer means verified; a bad `search` config leaves nothing restored      |
| Start new before stopping old                                    | 0     | 100%    | Not possible here: pinned ports, and Postgres and Typesense own their data directories     |

Per-path would help one case the tail does not: a slow routed Service in the middle, such as `/admin`. No Project here has one, and it can be added later without undoing this.

## Open questions for the owner

1. **Adopt the tail rule on both sides, rather than per-path publication?** Recommendation: yes. Same gain on Melody and Fletcher, and no change for Projects without a tail.
2. **When a tail Service fails, roll back the whole deploy, or keep the new version running with that Service failed?** Recommendation: roll back. "A failed deploy restores the previous one" stays true and adds no new outcome. Keeping would avoid the second outage, but needs a third outcome, and a bad change to the tail Service itself would leave nothing restored.
3. **Which version?** The README calls a breaking change to a command or config major. Recommendation: minor, with a release note. Every `rig.yaml` stays valid and ends in the same state with the same exit codes. Only the documented "before anything is published" narrows. A strict reading would make it major, which is a fair call if you read it that way.
4. **Names.** "Tail" is this ADR's working word, and `servedAt` would be public in the `deployments` read. Recommendation: keep "tail" out of user-facing text and CONTEXT.md, and approve `servedAt`, or name another.

## Implementation slices

Slices 1 and 2 can ship alone. Slices 3 and 4 ship in one release, because 3 widens the gap 4 closes. Tests use the recording router and controlled supervisor fixtures of `tests/verified-routes.test.ts` and `tests/activation-gates.test.ts`, under an isolated `RIG_ROOT`.

1. **The tail, as a pure function of a plan and the Services acted on.** No behaviour change. Tests: each Project shape in the table above; Share's dependent is excluded; a transitive dependent is excluded; a kept routed Service is transparent; no paths gives no tail.
2. **Stop side**, with its half of the guard and the `ROUTE_WITHHOLD` wording. Tests: with a blocked `search` stop, `/` stays live and is withheld before `web` stops; plain `rig down`, `--no-up` and Preview destroy still withhold first; a routed Service that exits during the tail's stop is withheld within a pass; a Project with no tail makes the same route calls in the same order.
3. **Start side**, with Tools moved, its half of the guard and the docs (`docs/rig-guide.md` start check, routing and start order). Tests: a pending tail start check with `/` already live; a tail failure withholds, stops and restores the previous plan and route; a published Service that exits during the tail fails the start within a pass; a publish failure stops the tail from starting; a Tool failure happens before publication; rollback's own start publishes before the previous tail. One live Caddy test in the existing e2e file: a slow tail, real requests answering through it.
4. **Recovery duty.** Tests: rigd killed mid-tail keeps paths live while Services run; an exit withholds only that path; a restart with a pending `recovery` withholds paths to dead ports; `rig down` still settles it; a failed observation withholds nothing and retries.
5. **Receipts:** `servedAt`, Activity text, the failure's hint, and the dashboard's history row. Tests: a failed deploy that served says so and one that did not does not; a state file with the field reads on the current version.

On acceptance, CONTEXT.md's route relationship needs no change: "from its verified start until just before it stops" is what this makes true.

Claude Opus 5.5 on behalf of Brendon
