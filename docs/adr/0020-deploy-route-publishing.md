---
status: accepted
---

# A deploy keeps a Target's paths up around the Services they do not need

## Problem

A deploy that really restarts a slow Service takes the whole site down for that Service's full stop and start, even when no path reaches it ([#726](https://github.com/b-relay/rig/issues/726)). `lifecycle.down` withholds every path before anything stops, and `lifecycle.up` publishes only after the last Service is verified.

The [#725](https://github.com/b-relay/rig/issues/725) incident on Melody, whose plan is `db, api, web, search`:

| Part of the outage                                    | From → to           | Length |
| ----------------------------------------------------- | ------------------- | ------ |
| `search` stops; `web` and `api` run, but are withheld | 15:23:35 → 15:24:36 | 61 s   |
| `web`, `api`, `db` stop and start                     | 15:24:36 → 15:25:08 | 32 s   |
| `search` loads                                        | 15:25:08 → 15:30:06 | 4m58s  |
| The last checks and the publish                       | 15:30:06 → 15:30:26 | 20 s   |
| **Total**                                             |                     | 6m51s  |

Melody's `rig.yaml` already says what it expects: "`search` comes last on purpose ... so the site is up first". Rig does not do that.

The 1.0.2 fix for #725 stops the false restart, so this is no longer every Melody deploy. It remains whenever `search` really restarts along with `api` or `web`: both changed in one deploy, `--force`, `rig restart`, a Mac restart. A change to `search` alone already costs no 503, because ADR 0016 keeps `api` and `web`. Fletcher is worse on the stop side. Its schedulers have `stop_timeout: 25m` and `2m` and no `watch`, so every deploy can answer 503 for up to 27 minutes while `web` runs.

[#242](https://github.com/b-relay/rig/issues/242) does not require all-at-end. It requires that a path reach only a verified activation. That a failed start served nothing new is a consequence of the implementation, though the guide does promise it ("before anything is published").

## Decision

### The tail

A stop or start acts on a list of Services in plan order. Its **tail** is the longest run at the end of that list in which no Service has a path, and none depends, directly or transitively, on a Service that has one. A plan with no paths has no tail. A Service the start finds already running (a kept one) is not in the list, but it still counts in the dependency graph: the tail is computed from the full plan and the names acted on, because `withoutServices` drops a kept Service's definition and with it the edge from a worker to a routed `api` that is kept. "Tail" is this ADR's word only: it stays out of user-facing text and CONTEXT.md.

Dependency order puts everything a routed Service `depends_on` before it, so nothing a path declares a need for can be in the tail. The second condition is there for Share, whose `server` calls `explorer` while `explorer` `depends_on: [server]`. They cannot be reordered, and without that condition `/` would break for up to a minute of each restart.

| Project                      | Plan                                                          | Tail                                  |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------- |
| melody                       | `db, api, web, search`                                        | `search`, when it restarts            |
| fletcher                     | `comparison-refresh, web, google-scheduler, points-scheduler` | both schedulers                       |
| share                        | `server, explorer`                                            | none (`explorer` depends on `server`) |
| pantry, vitals, podcast, rig | all needed, or one Service                                    | none                                  |

A stop or start with no tail makes today's sequence of stops, starts and publishes. The only addition is the guard, which acts only if a Service with a live path exits.

### Start: publish before the tail

This applies to every `lifecycle.up`, so a Mac restart and `rig up` gain it too.

1. Withhold the paths of stopped Services (as today).
2. Start the Services before the tail, in plan order, each passing its start check (as today).
3. Install Tools. They move ahead of the tail, so a failure that need not follow publication does not.
4. Verify those Services again and publish every path in one change (today's checks, earlier).
5. Start the tail in plan order, under the guard.
6. Verify everything again and finish. A deploy commits only here.

Rig never reorders Services. All paths still flip together, so `melody.b-relay.com` and `api.melody.b-relay.com` change as one.

### Stop: the tail goes first when something replaces it

The stop order does not change: reverse plan order already stops the tail first. Only the withhold moves, from before the first stop to before the first Service outside the tail. It is still one change, and the rule that a path is withheld before its Service stops still holds.

This mode is used only by a deploy's stop of the previous Deployment and by `rig restart`, where the site is expected back. Everything else withholds before its first Service stops, as today: plain `rig down` (which stops its job runs before that) and `--kill`, `deploy --no-up`, Preview stop and destroy, `forget`, a reconcile pass, a recovery stop, and every rollback. `rig down` may be incident response, has no successor, and must not keep serving through a stop that can last up to an hour.

### The guard

Automatic restart passes skip a Target an operation holds ([ADR 0007](0007-per-target-operation-queue.md)), and health checks pause while one does. #745 and #751 did not change that: their withholding after a Host restart runs inside the pass. Today that blind spot only covers kept Services. With live paths through a tail it would cover the site for minutes, and a freed port with a live path breaks the rule that a program taking that port never receives its requests.

So the operation observes every Service with a live path once a second, under the same bound as other observations. As in #751, only a Service **seen stopped** has its paths withheld. An observation that is unknown or does not answer decides nothing, since that Service may still run, and the next look tries again, as it does after a withhold the proxy refuses. A health check that goes bad but leaves the process running is caught by step 6, not sooner.

**How long it runs.** From the operation's first stop until it releases the Target and supervision can resume. That covers the tail's stop and start, step 6's final checks (each can use a Service's whole readiness budget), failure cleanup, a rollback's stops and start, and finalization. One guard belongs to the operation, not to a start: a deploy or `rig restart` holds one across its stop and start, a rollback included, and a lone `up` makes its own. With nothing live, it observes nothing.

**What a stopped Service does to the operation.**

- **Started by this start, before the commit is decided:** the start fails and rolls back. The failure cancels a pending start check or final check, as a readiness deadline already does. A spawn in flight settles first, so its process is recorded in `started` and gets stopped.
- **Otherwise** (kept, about to be replaced, or the commit is decided): the operation carries on, and restart policy takes over once it releases the Target.

**Stopping and joining.** One round runs at a time. Every route change the operation makes itself (the stop's withhold, the publish, the failure path's withhold, checkpoint restore and commit) runs inside the guard's exclusive section: it stops the loop, joins the round in flight, makes the change, then reads the live paths again before the loop resumes. Each round is bounded, and an answer that arrives after its round is dropped, so a stale observation never withholds a path published since and never races compensation. The guard is joined for the last time before the Target is released.

**The commit decision is inside that section too.** A deploy's irreversible step is the durable write of `recovery.stage = "committing"`, which authorizes rolling forward, and cancelling a readiness check cannot cancel a write already underway. So the deploy enters the section, joins the round, and rejects any start failure the guard has latched. Only then does it persist `committing`, establish the decision, commit the checkpoint and resume. A failure latched after `up` has returned rolls back through the deploy's catch, as a failed `committing` write does today. An exit seen after the write is a decided commit: the deploy stays `deployed`, and restart policy takes over. A start with no deploy around it does the same around its checkpoint commit.

Notes for the builder:

- **The section covers the whole effects call,** from its first route read (`route` and `withhold` both begin with `router.checkpoint`) to the journal's final capture in `withRouteChange`.
- **Join before entering the router queue.** The guard's own withhold is part of its round and never enters the exclusive section, or it would join itself.
- **Join the bounded result of `boundedObservations`, not the provider's promise.** An uncooperative observation expires with the provider still unanswered.
- **A cancelled readiness check settles through a failure race,** following `awaitActivation`'s existing deadline pattern.
- **A spawn already underway cannot be abandoned through that race.** It settles and enters `started` before cleanup begins.
- **A route mutation already underway finishes through journal capture** before compensation proceeds.
- **The journal's other writers take the section too.** A route change and a Tool's change save the same journal file, so a look's withhold beside them could put an older copy on disk over a newer one. Creating the checkpoint, retiring superseded Tools and installing a Tool therefore also run in the section. Tools are built earlier, while the previous Deployment serves, so installing one only publishes what was built; a kept Service that exits while a Tool is published is seen once that publication ends.
- **A look reads a live port by the plan the route was last published under,** which the operation knows, since nothing else writes the route while it holds the Target. It does not use both plans as the recovery duty must, so a port a new plan gives another Service still goes when the Service behind it now is seen stopped.

An automatic or health restart (`recover`) has no tail and is unchanged.

### A late failure rolls back

A failed deploy restores the previous one, as it always has. When a tail Service fails after the paths were published, or a published Service stops during the tail, `up`'s failure path withholds what it started and stops it, and the deploy restores and starts the previous plan. There is no new phase and no new rollback path. What changes is what Rig says:

- **The error and Activity** say the new Commit was served, from when and for how long. The hint "nothing of this start was published" is shown only when true.
- **`DeploymentRecord`** gains an optional public `servedAt`, so the dashboard's history can show it. An optional field needs no state version (see the note on `STATE_VERSION`).
- **`rig status`** during the tail shows the deploy in progress as it does now, with paths live, read from the route block as it already is. After a rollback it shows the previous Commit.

**Recording what was served.** `withRouteChange` records route bytes, not times, and history and Activity are written when the operation finishes, after any rollback. So `finishedAt - servedAt` is not the time served, and an in-memory time would die with rigd. The record is `recovery.served`, an optional internal field a rigd that does not know it ignores:

| When                                                                                       | What is written                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------- |
| Before a publish that gives a path to a Service this start started                         | `served: {}`: it may have served      |
| After the router confirms that publish                                                     | `from`, which becomes `servedAt`      |
| After a confirmed route change removes the last path reaching a Service this start started | `until`, the end of candidate service |

- **Which publishes count.** Only the candidate's start reports them, through its `ActivationJournal`. The rollback's `up(previous)` has its own journal, so its publication is never attributed to the new Commit, and it ends nothing. A publish that reaches only kept Services records nothing, because no new code is behind it.
- **Which withdrawals end it.** Only a path reaching a Service this start started counts as serving the candidate, whichever change removes it, the guard's included. With `api` kept and `web` and `search` restarted, a guard withdrawal of `web`'s path sets `until`, although the kept `api` path stays live and `search`'s spawn is still pending. The first `until` stands when cleanup confirms withholding again. Withdrawing one candidate path while another still serves sets nothing.
- **How it reaches the receipts.** The deploy keeps the values beside `deployKept`, which `record` reads for Activity and `DeploymentRecord`, so wrapping in `DEPLOY_RESTORE_FAILED` or `DEPLOY_ROLLBACK_BLOCKED` cannot lose them. Activity states the length as `until - from`, and the error says the same at the deploy's boundary. A successful deploy has `servedAt` and no `until`. No new public field carries the end.
- **After a crash.** There is no operation left to record, so the `rig down` that settles the `recovery` does: it adds a `failed` history entry under `recovery.operationId` and an Activity line, only when `served` is present. With no `from`, it says the Commit may have been served, at an unknown time. With no `until`, it says until at most the moment its own withhold was confirmed. A `committing` stage is a completed deploy, so its entry says `deployed`. History and Activity are written in the same store write that clears `recovery`, inside `settleRecovery`, because `recordDeployment` appends without deduplicating and a retried `rig down` must not add a second entry.
- **No `STATE_VERSION` bump.** The review confirmed that 1.0.4 preserved `recovery.served` and `servedAt`, and that its recovery `down` settled cleanly.
- **`rig up`, `rig restart` and a Mac restart** have no `recovery` and no deploy record. They use the same journal calls in memory, for the hint only.

**What it costs.** A second outage, and new code served and then reverted. Nothing old is left to fall back on, because whatever restarted stopped before its new copy started. If Melody's `search` fails at its 15-minute `start_period`:

1. The first outage is the usual 32 s or so, plus the checks and publish (see [What each deploy costs](#what-each-deploy-costs)).
2. The new version serves for up to 15 minutes.
3. Every path it started is withheld at once, `search` stops within its 1 minute and the rest stop.
4. The previous `db`, `api` and `web` start, about 32 s, then the same checks and publish. That second outage is up to about 1m32s, plus those.
5. The previous `search` loads for about 5 minutes with the site up.

That is about 2 to 3 minutes of 503s in two parts, against about 23 minutes without a break today. Those figures are worked out, not measured.

The data risk is smaller than it looks. `api` already runs migrations before it listens, so a rollback today already returns to old code on a migrated database. What is added is data users wrote through the new code in that window, which old code must then read. That is the same exposure as the dashboard's rollback. Only Projects with a tail are exposed, and only when the tail fails. A Project that will not accept it moves that Service above its last routed Service.

A start with no previous version to restore (`rig up`, `rig restart`, a Mac restart) stops what it started and reports `failed`, as it does today. The site then goes down after having served, where today it never came up. After a Mac restart, #745 and #751 withhold the paths of those Services once they are seen stopped.

### Consequences

**Order.** A Service that `depends_on` a slower one waits for it, and so do all paths: the slower one is ahead of it. A Service an app reaches without declaring it is safe when listed above the last routed Service, as serial start already gates it. Listed below, it is the tail, and the app runs without it for the tail's stop and start. That is the real risk of this change. It is bounded by the tail's stop and start time, and the Project fixes it with `depends_on` or by moving a line. Position in `rig.yaml` already decides what starts first, and now it also decides what the site waits for, which is what Melody's comment assumes. Reordering automatically, as the issue suggests, would break a `redis` listed first with no `depends_on`, at start and not only in routing.

**Default, no knob, 1.1.0.** Order is already the setting, so a key would say the same thing twice and split the tested behaviour in two. Nothing in `rig.yaml` needs to change, and five of the seven Projects here see no difference. This is a minor release with a release note: every `rig.yaml` stays valid and ends in the same state with the same exit codes. The documented "before anything is published" narrows, and a Project with an undeclared need on its tail sees errors where it saw 503s; the note says so.

**Kept Services (ADR 0016).** No change: a kept Service's path is never withheld. A kept Service is not in the list, so `web` kept with `api` and `search` restarting gives `search` as the tail. If only tail Services restart, nothing is withheld at all, as today. A port a deploy newly gives a kept Service is published at step 4 once its process is found listening. Rollback leaves untouched kept Services alone as today.

**Old and new versions.** No different from today. Everything outside the tail restarts inside one withheld window and is published together, so a new `web` never reaches an old `api`, unless `api` is kept, which ADR 0016 already accepts as "unchanged means equivalent". The only new overlaps are old code with its tail stopping and new code with its tail loading, which are the tail being absent rather than a version mix. Per-path publication would add new `web` against a stopped `api`.

**Stopping.** A tail Service that fails to stop is collected as today, and the rest still stop. A withhold that fails after the tail stopped takes the existing `ROUTE_WITHHOLD` path, which already ends in `DEPLOY_ROLLBACK_BLOCKED`; only its wording "nothing was stopped" becomes "no Service with a path was stopped".

**Other Targets and cost.** Previews and working Targets use the same `lifecycle.up` and the same rule. A Target with no route has no tail. The dashboard's hostname is rigd's own route and is untouched. Melody makes the same three publishes as today (withhold, start's withhold, publish), so there is no reload per Service.

### Crash recovery

Publishing is journalled by `withRouteChange` as it is today, and `stopForRecovery` already withholds everything and stops both plans. The only new record is `recovery.served` above.

- **rigd dies during the tail (start or stop).** Services keep running and `recovery` stays pending. The next rigd restarts Caddy from `current`, which holds the live paths. The site keeps serving until someone runs `rig down`, where today it would answer 503. `rig up` and `rig deploy` are still refused with `DEPLOY_RECOVERY`.
- **A gap this widens.** A Target with a pending `recovery` is neither supervised nor checked: `eligible` excludes it from every pass, and only the first reconcile takes it, and that returns before `withholdStoppedServices`. So a live path to a Service that exits stays live, and after a Mac restart Caddy starts with paths to dead ports. #745 and #751 left this case to this design. It exists today for kept Services' paths, and it becomes the common case.
- **So every pass admits an unresolved recovery to one duty,** whatever `desired` says, on the rules #751 set. It joins `passed` but not `eligible`, so it gets no automatic start, no supervision and no health checks, and takes a Target only when it is free, so a deploy still running keeps its own guard. The failure list keeps its route failures rather than dropping them as about a Target no longer supervised.
- **The duty:** read the live paths, observe the Services behind them under both recorded plans, and withhold those seen stopped. Unknown or unanswered decides nothing, and is logged as `routes-unchecked`, and `routes-checked` once none is left. A proxy that refuses is reported as a supervision failure. Both retry on the next pass. It restarts nothing. `withholdStoppedServices` cannot be called as it is, because it picks Services by what their record keeps stopped and reads one plan. This duty ignores the records and withholds under both plans' ports, since the route may name either. A port the two plans give to different Services goes only once both are seen stopped, since either may be what the route reaches.
- **A Target with no `recovery`** (`rig up`, `rig restart`, a Mac restart) behaves as today: desired state decides whether the next pass supervises or stops it, and #745 and #751 cover the paths of Services seen stopped.

## What each deploy costs

Worked out from the #725 log and each `rig.yaml`: none of these was measured. Outage means 503s. **A typical code-only Melody deploy does not change**, because `db` and `search` are kept, so there is no tail to work around. The tail rule helps the rarer deploys that restart `search` with the site, and every deploy of Fletcher's.

Moving the checks and the publish ahead of the tail does not remove their cost. So a projection is the stop and start of the Services before the tail, **plus** their second checks, Tools and publication, whose timing is unknown. The only evidence is the 20 s in #725 between `search ~ ready` and publication. The log does not say what took it, so each Melody figure below is a range, from none of that 20 s to all of it. The upper end is the honest one to plan on.

| Deploy                                         | Today                                            | With the tail rule                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Melody, code only (`db`, `search` kept)        | 30 to 50 s                                       | 30 to 50 s: unchanged                                                                                                                                 |
| Melody, `search` alone                         | 0                                                | 0: unchanged                                                                                                                                          |
| Melody, `db` changes, `search` kept            | 32 to 52 s                                       | 32 to 52 s: unchanged                                                                                                                                 |
| Melody, code and `search` together             | about 6m50s                                      | 30 to 50 s                                                                                                                                            |
| Melody, everything restarts (#725's shape)     | 6m51s, the log's own figure                      | 32 to 52 s                                                                                                                                            |
| Melody, `rig restart`                          | about 6m50s                                      | 32 to 52 s                                                                                                                                            |
| Melody, Mac restart, until the site answers    | about 5m50s                                      | 30 to 50 s                                                                                                                                            |
| Melody, `search` fails at its 15-minute budget | about 23 min without a break                     | about 2 to 3 min in two parts                                                                                                                         |
| Fletcher, every deploy as configured           | up to 27 min, plus everything in the next column | `comparison-refresh` and `web` stop and start, plus their checks, its Tools and publication; none timed, and each start check alone has a 30 s budget |

## Alternatives

Melody's #725 outage was 6m51s. All figures are worked out from that log, each range for the checks and publish as above.

| Option                                                           | Left           | Removed        | Risk added                                                                                 |
| ---------------------------------------------------------------- | -------------- | -------------- | ------------------------------------------------------------------------------------------ |
| Rely on the 1.0.2 fix alone                                      | 6m51s          | 0              | None; every real restart stays as it is                                                    |
| Stop side only                                                   | 5m50s          | 15%            | Low: only old code keeps serving. But removes up to 27 min for Fletcher                    |
| Start side only                                                  | 1m33s to 1m53s | 73 to 77%      | Medium: served then rolled back; the guard; crash recovery                                 |
| **Tail on both sides (decided)**                                 | 32 to 52 s     | 87 to 92%      | Medium: as above, only for Projects with a tail                                            |
| Per-path both sides (the issue's candidate)                      | about the same | about the same | Higher: every multi-path Project gets partial publication and version gaps; 2k+1 publishes |
| Exclude every unrouted Service from the wait, starting them last | 1m33s to 1m53s | 73 to 77%      | Higher: reordering breaks undeclared prerequisites at start; Share's `/` breaks            |
| Commit at site-up, tail in the background, with the stop side    | 32 to 52 s     | 87 to 92%      | High: success no longer means verified; a bad `search` config leaves nothing restored      |

Per-path would help one case the tail does not: a slow routed Service in the middle, such as `/admin`. No Project here has one, and it can be added later without undoing this.

Starting the new version beside the old one was designed and then shelved as [#765](https://github.com/b-relay/rig/issues/765). Nothing here depends on it.

## Decisions

The owner approved all of these, and nothing is left open:

- The tail rule on both sides of a deploy.
- A late tail failure rolls back, and the error, Activity and `servedAt` say the new version was served.
- 1.1.0, a minor release, with a release note.
- `servedAt` as the public field. "Tail" stays internal.

## Implementation slices

Tests use the recording router and controlled supervisor fixtures of `tests/verified-routes.test.ts` and `tests/activation-gates.test.ts`, under an isolated `RIG_ROOT`. Each slice updates the docs for what it changes, and each is testable on its own.

**Release order.** A released build must never leave old paths live with nothing watching them, or serve a candidate and still say nothing was published. So slice 2 ships before or with slice 3, and slice 4 before or with slice 5.

1. **The tail, as a pure function of the full plan and the names acted on.** No behaviour change. Tests: each Project shape in the table; Share's dependent is excluded; a transitive dependent is excluded; a transitive dependency through a kept routed Service still excludes; a kept tail Service leaves the list; a kept routed Service is transparent; a Service with only a Service `domain` and one with only a `proxy` path each end the tail; no paths gives no tail.
2. **Recovery duty and admission.** This also closes today's gap for kept Services. Tests: a Service that survives the first pass and exits later is withheld by a later pass; only that Service's paths go, under either recorded plan's port; a Mac restart with a pending `recovery` withholds paths to dead ports; an unknown observation withholds nothing, logs `routes-unchecked` and retries; a proxy failure is reported and retried; it applies with `desired` stopped too; nothing starts, and a Target an operation holds is skipped; `rig down` still settles it.
3. **The guard and the stop side,** with the `ROUTE_WITHHOLD` wording. Tests: with a blocked `search` stop, `/` stays live and is withheld before `web` stops; plain `rig down`, `--no-up` and Preview destroy still withhold before their first stop; rigd killed during the tail's stop leaves old paths to slice 2's duty; a routed Service seen stopped during the tail's stop is withheld within a second; one whose state is unknown keeps its path; a round held in flight is joined before the stop's withhold, and its late answer changes nothing; a Project with no tail makes the same route calls in the same order.
4. **Receipts:** `recovery.served`, `servedAt`, Activity text, the failure's hint and the dashboard's history row. Testable before slice 5, because today's publish can already be followed by a failed finalization. Tests: a failed deploy that served says so and one that did not does not; a publish reaching only kept Services records nothing; the rollback's publication is not attributed to the new Commit, and the length served excludes rollback and the previous version; rigd killed before `from`, after `from` and after `until` each settles with the right words at `rig down`; a failed settling write leaves `recovery` and no entry, and a retried `rig down` adds exactly one; a state file with the field reads on the current version.
5. **Start side,** with Tools moved, the guard through steps 5 and 6 and cleanup, and `docs/rig-guide.md` (start check, routing and start order). Tests: a pending tail start check with `/` already live; a tail failure withholds, stops and restores the previous plan and route; a routed exit during step 6, with a pending final check of `db`, is withheld within a second, cancels that check and fails the start; a kept routed exit during failure cleanup's long stop is withheld; with `api` kept and `web` and `search` restarted, the guard's withdrawal of `web`'s path during `search`'s pending spawn sets `until`, and cleanup's later withhold keeps it; a spawn in flight settles into `started` and is stopped; a failure latched just before the commit section rolls back with no `committing` written; an exit during the `committing` write is judged after it, and an exit after the durable decision leaves the deploy `deployed`; a state unknown fails nothing; a publish failure stops the tail from starting; a Tool failure happens before publication; rollback's own start publishes before the previous tail; a failed tail after a Mac restart is recorded `failed` with those paths withheld. One live Caddy test in the existing e2e file: a slow tail, real requests answering through it.
6. **Release 1.1.0,** with the note on Service order and a served-then-reverted deploy.

CONTEXT.md's route relationship needs no change: "from its verified start until just before it stops" is what this makes true.

Claude Opus 5.5 on behalf of Brendon
