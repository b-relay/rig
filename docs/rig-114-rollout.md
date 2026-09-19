# Configuration cutover: Host rollout runbook

This is the procedure for moving one Host from the JSON-configuration runtime to
the `rig.yaml` runtime (#114). It has been rehearsed only under temporary
`RIG_ROOT`s. **It has not been run against any live Host**, and neither tests
nor publishing the source run it. Status of #114:

| Stage                       | Status                                                           |
| --------------------------- | ---------------------------------------------------------------- |
| Accepted design             | done: `plans/114-config-spec.md`                                 |
| Source-ready implementation | done at the revision below                                       |
| Isolated rehearsal          | done: `tests/conversion.test.ts`, `tests/release-matrix.test.ts` |
| Live deployment on a Host   | **not done**; this document is its procedure                     |

## Tested revision and binaries

Filled in by the release gate (#245); see
`docs/reviews/2026-09-17-issue-245-release-gate.md` for the commands and results.

- Source revision: the Commit and tree recorded in the closing comment of #245
  (a file cannot hold the hash of its own tree). Use exactly that Commit;
  `git rev-parse HEAD^{tree}` must match the recorded tree.
- Binaries: `bun install --frozen-lockfile && bun run build` at that revision
  produces `./rig`, `./rigd` and `./git-remote-rig`. Build them on the Host, or
  copy the three files together; never mix them with older ones.
- The converter is not a binary. It runs from the same checkout:
  `bun run cutover …`.

Below, `OLD` is the directory of the binaries that are running today, `NEW` the
checkout with the freshly built ones, and `ROOT` the Rig root (`~/.rig` unless
`RIG_ROOT` is set). Run every `bun run cutover` from `NEW` with the same
`RIG_ROOT` the daemon uses.

## Inputs only the Host has

Decide these before starting; nothing in the source can answer them.

- Which Projects and Targets exist (`OLD/rig list`, `OLD/rig status --project <p>`),
  and which may be down for the length of the cutover.
- For every hook in every saved Target: is it only a build (`as: build`, managed
  `preStart` only), or what replaces it (`as: replaced, by: …`).
- Values of every env file that lives inside a repository. They move to
  `ROOT/env/<project>/[<service>/]{all,working,stable,preview}.env`, mode 600.
  Never commit them.
- Projects that used the built-in Postgres or Convex Components: their data
  directories stay where they are; the new Service (`rig recipe generate
postgres`) must be pointed at the existing directory by hand. Nothing is
  relocated automatically.
- Where an independent copy of `ROOT` can be stored.

## 1. Record the starting point (old runtime, read-only)

```sh
OLD/rig list
OLD/rig status --project <p>          # per Project: Targets, state, ports, routes
OLD/rigd status
ls ROOT/bin                            # published Tools
```

Keep the output. It is the affected-Target manifest for the checks in step 7.

## 2. Stop everything with the old runtime

```sh
OLD/rig down <target> --project <p>    # every running Target
OLD/rigd uninstall
OLD/rigd status                        # must say: not installed
launchctl list | grep -i rig           # must list no rig job of this root
```

The conversion stops nothing. It refuses while a daemon record or process lease
names a live pid, while a Target is recorded as running, and while a recovery,
incomplete deployment, pending destruction or effect journal is unresolved.
Settle those with the **old** runtime. Never start the new `rigd` on the root
before step 5: it would refuse the state (`STATE_UNCONVERTED`) and nothing else,
but two daemons must never share a root.

## 3. Independent backup, verified

```sh
tar -C "$(dirname ROOT)" -cf /safe/place/rig-root-before-114.tar "$(basename ROOT)"
tar -tf /safe/place/rig-root-before-114.tar | grep -c . # non-zero
shasum -a 256 /safe/place/rig-root-before-114.tar > /safe/place/rig-root-before-114.tar.sha256
```

This is the only copy of application data; the conversion's own backup holds
metadata only and says so in its manifest (`notCopied`, `dataPaths`). If the
data is too large to copy, snapshot the volume instead, and do not continue
without one of the two.

## 4. Inventory, review, preview

```sh
cd NEW
bun run cutover inventory  > /safe/place/inventory.json
$EDITOR /safe/place/review.yaml        # one decision per hook; see the guide
bun run cutover preview --review /safe/place/review.yaml > /safe/place/preview.json
```

Read the preview completely:

- `blockers` must be empty. Each names what to settle. A Host `config.json`
  always blocks: save `host.candidate` as `ROOT/config.yaml` yourself and remove
  `config.json` (both runtimes read `config.yaml`).
- Per Target, `start`: `saved-plan` starts as saved; `working-copy` is planned
  again from `rig.yaml`; **`needs-deploy` will not start until a new Commit is
  deployed** (step 6). Plan the downtime of those Targets accordingly.
- Per Target, `dataRoot`, `logRoot`, `workspacePath` must be exactly the paths
  in use today.
- Per Project, the candidate `rig.yaml` and its `notes`.
- Note the `revision`.

Both commands are read-only; repeat them as often as needed.

## 5. Apply, then activate one Project

```sh
bun run cutover apply --review /safe/place/review.yaml --revision <revision>
# prints backupPath and reportPath; keep both
NEW/rigd install
NEW/rigd status
NEW/rig list
NEW/rig status --project <p>
```

Apply changes one existing file, `ROOT/runtime/state.json`, last and atomically.
If it stops earlier, the root is still unconverted; `preview` names the
unfinished attempt under `interrupted`, and the same command finishes it.

Activate one low-risk Project first, then the rest.

## 6. Commit the new configuration and deploy

Per Project, in its repository:

```sh
cp ROOT/conversion/<revision>/<project>.rig.yaml rig.yaml   # then edit per its notes
git rm rig.json                                             # and any committed env file
NEW/rig doctor --project <p>
git add rig.yaml && git commit -m "chore: move to rig.yaml"
NEW/rig deploy <stable-target> --project <p>                # or push the Production branch
```

Put env-file values in `ROOT/env/…` before deploying. A Commit that still holds
`rig.json` is refused with guidance. `saved-plan` Targets can be started before
this step with `NEW/rig up <target> --project <p>`.

## 7. Checks per activated Target

Compare with the manifest from step 1.

| Check    | Command                                                                          | Expected                                                                              |
| -------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| State    | `NEW/rig status --project <p>`                                                   | every Target listed, same names, running ones `running`                               |
| Health   | `curl -fsS http://127.0.0.1:<port><ready path>`                                  | 2xx                                                                                   |
| Listener | `lsof -nP -iTCP:<port> -sTCP:LISTEN`                                             | bound on `127.0.0.1` only                                                             |
| Route    | `curl -fsS -H 'Host: <domain>' http://127.0.0.1:<caddy port>/` or the public URL | the application, not a Caddy error                                                    |
| Tools    | `ls -l ROOT/bin`; run each with a harmless argument                              | Stable Tool under its plain name; Working copy and Preview Tools as `<tool>-<target>` |
| Data     | application-level read of a known record; `ls <dataRoot>`                        | present and unchanged; same path as in the preview                                    |
| Logs     | `NEW/rig logs <target> --project <p>`                                            | new lines appended under the same `logRoot`                                           |
| Doctor   | `NEW/rig doctor --project <p>`                                                   | no failed check                                                                       |

## 8. Rollback

Triggers, any one of:

- `NEW/rigd install` or `NEW/rig status` fails on the converted root.
- A `saved-plan` Target does not reach ready and the cause is not an ordinary
  application fault.
- A data check in step 7 fails. Stop immediately; do not deploy further.
- The candidate `rig.yaml` of a Project that must not stay down cannot be made
  to pass `rig doctor` in the time available.

Actions:

```sh
NEW/rig down <target> --project <p>    # every Target the new runtime started
NEW/rigd uninstall
cd NEW && bun run cutover rollback --backup <backupPath from step 5>
# if config.yaml was created from config.json in step 4, both runtimes read it: leave it
OLD/rigd install
OLD/rig status --project <p>
OLD/rig up <target> --project <p>
```

Rollback restores `runtime/state.json` only, after checking that the backup
belongs to this root and matches its manifest, and refuses while anything is
alive on the root. Application data and logs are never touched by either
direction. Limits: Deployments made by the new runtime after the conversion are
unknown to the restored state (their checkouts remain on disk), and a repository
already committed to `rig.yaml` needs its previous Commit deployed for the old
runtime. If the state backup itself is damaged, restore `ROOT/runtime/state.json`
from the tar of step 3.

## What the rehearsal does not prove

The isolated rehearsal uses a fixture root written in the shapes captured from
the last JSON runtime, under a temporary directory, with its own daemon. It does
not prove:

- that this Host's state has no field the converter does not know (the preview
  reports that as `unsupported_mapping` and blocks; it cannot be known ahead);
- behavior with this Host's launchd domain, real Caddy routes, TLS or DNS;
- that every hook on this Host was classified correctly (a human decision);
- stale pid records: a reused pid is a false `daemon_running`/`live_process`
  blocker and must be checked by hand before removing the record;
- old daemons installed in launchd mode are detected through
  `ROOT/daemon/owner.json` only, hence the explicit `launchctl list` in step 2;
- application-level data compatibility of Postgres/Convex moved onto recipe
  Services.
