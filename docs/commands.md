# Rig Command Reference

Every command, argument, and flag of `rig` and `rigd`. The
[guide](rig-guide.md) explains what the commands do; this page is the map.

Every command answers `-h` and `--help`. `rig` and `rigd` also answer `-V` and
`--version`, and print help when run with no arguments.

## rig

```
rig
├─ init                             write rig.yaml and register the Project
│    --project <name>               identity (default: existing config, then repo name)
│    --path <path>                  repository to initialize (default ".")
│    --production-branch <branch>
│    --create-git                   run git init when the directory is not a repository
│    --domain <domain>              stable Target domain; Previews get <first label>-<name>
│    --service <name>  --command <command>  --port <port>  --healthcheck <test>
│    --tool <name>     --bin <path>     --tool-build <command>
│
├─ list                             all Projects on this Host
│    --json
├─ status                           all Targets of one Project
│    --project <name>   --json
├─ doctor                           Host checks, plus Project checks when in one
│    --project <name>   --json
├─ config                           show the validated rig.yaml and its path
│    --project <name>   --json
├─ activity [operation]             what Rig did, newest last, or one Operation by id (looked up on the whole Host)
│    --project <name>               another Project's (default: the one this directory is in)
│    --all                          every Project's, and rigd's own administration
│    --target <name>                only this Target's: working, stable or a Preview's name
│    --action <action>              only this action, such as deploy, crash or job
│    --outcome <outcome>            only this outcome, such as failed
│    --since <time>  --until <time> 1h, 15m, 2d … back from now, or an ISO time with a zone
│    --lines <count>                default 20, at most 10000, counted after filtering
│    --json                         one record per line (JSON Lines)
├─ monitor                          CPU and memory of one Project, redrawn every sample on a terminal
│    --project <name>
│    --all                          every Project, Rig itself and the Host's total
│    --since <time>  --until <time> the window the median and peak cover (default: the last 1h);
│                                   a duration back from now or an ISO time; with --until it prints once
│    --json                         print the report once
│
├─ deploy [target] [branch]         target: "stable" (default) or "preview"
│    --project <name>
│    --force                        redeploy the same Commit
│    --no-up                        deploy without starting
│    --deployment <name>            explicit Preview name
│
├─ up      [target] [branch]        target: "working" (default), "stable" or "preview"
├─ restart [target] [branch]
├─ down    [target] [branch]
│    --project <name>   --deployment <name>
│    --destroy                      down only: delete a Preview and its own data
│    --kill                         down and restart: skip stop_timeout (SIGTERM, SIGKILL after 1.5 s),
│                                   and cut short a stop already running on the Target
│
├─ run <job> [target] [branch]      start a scheduled job now; target: "stable" (default), "working" or "preview"
│    --project <name>   --deployment <name>
│
├─ backup
│  ├─ list [job] [target] [branch]  kept backups, each job's newest first: time, size, the run that made them;
│  │                                every Target's unless one is named
│  │    --project <name>   --deployment <name>   --json
│  └─ restore <job> <id|latest> [target] [branch]
│                                   run the job's backup.restore once against a backup, then wait;
│                                   target: "stable" (default), "working" or "preview"
│       --project <name>   --deployment <name>
│       --yes                       restore without asking
│
├─ logs [target] [branch]
│    --project <name>   --deployment <name>
│    --follow                       stream until interrupted, after the matching history
│    --lines <count>                default 50, at most 10000, counted after filtering
│    --service <name>               only this Service's or Tool's lines; repeatable
│    --stream stdout|stderr         only this stream
│    --since <time>  --until <time> 1h, 15m, 2d … back from now, or an ISO time with a zone;
│                                   --until cannot be combined with --follow
│    --full                         print every line whole (default: shortened past 2,000 characters)
│    --json                         one entry per line (JSON Lines)
│
├─ rename <name>                    new identity; the Project must be stopped
│    --project <name>               current identity
├─ repoint <path>                   new repository path; the Project must be stopped
│    --project <name>
├─ forget <name>                    drop a stopped Project's registration and withdraw its routes; its Tools stay
│
├─ proxy                            Rig's own Caddy: its job and every served hostname, proxy.routes included
│    --json
│  ├─ reload                        withdraw routes whose Target no longer exists, then apply Host config's proxy
│  │                                section (proxy.routes, ports, certificates) as it is now; without Rig's own
│  │                                Caddy it only withdraws
│  ├─ verify                        TLS handshake per served hostname; exits 1 when any is not ready
│  │   --port <port>                default: proxy.ports.https
│  │   --wait <seconds>             keep checking failing hostnames this long
│  │   --staging-ok                 accept certificates from a staging CA
│  │   --json                       { ready, hostnames, error? }; still exits 1 when not ready
│  └─ token                         store the DNS API token read from a pipe (pbpaste | rig proxy token)
│
├─ dns                              your Cloudflare records, with the proxy's token (ADR 0018)
│  ├─ list [zone]                   every zone's records, and where each served hostname points
│  │   --json
│  ├─ set <name> <type> <content>   create, or change the one A/AAAA/CNAME of that name; TXT/MX/CAA add one
│  │   --ttl <seconds|auto>         default: the record's own, else auto
│  │   --proxied / --no-proxied     A, AAAA, CNAME only
│  │   --priority <number>          MX (default: the record's own, else 10)
│  │   --comment <text>
│  │   --add                        add another record of that name and type
│  │   --replace                    TXT, MX, CAA: change the one record there instead of adding
│  │   --zone <zone>                makes the name relative to this zone (needed for a dotted one)
│  │   -y, --yes                    write without asking (required without a terminal)
│  └─ delete <name> <type>          delete the record of that name and type
│      --content <content>          pick one of several
│      --zone <zone>
│      -y, --yes
│
└─ help [command...]                for example: rig help deploy preview
```

## rigd

```
rigd
├─ install                          install and verify the daemon, and Rig's Caddy with a proxy section;
│                                   with daemon.start: boot, prints one sudo line per system job, once
├─ status                           installed, running, reachable
├─ upgrade [version]                install the latest release (or the one named, to roll back) through
│                                   that release's install script: rig, rigd and the dashboard; an
│                                   installed release missing any of them, or rigd serving it, again
│    --check                        only say whether that release differs from the one installed, or
│                                   is installed incompletely
├─ uninstall                        refused while Targets run or await recovery; prints the sudo
│                                   line that removes a system job
└─ capture <request-file>           internal; see below
```

`rigd capture` is not a user command. `rigd`'s child supervisor runs
`rigd capture <request-file>` for each Service instead of the Service's own
command. The wrapper starts the Service as its child, writes its output to the
Target logs, and records its status and exit, so how the Service ended is
known even when `rigd` was not there to see it. The request file is a small
JSON document `rigd` writes for that Service: its command, working directory,
environment, and log directory.

## Behavior The Tree Does Not Show

- Target names are fixed: `working`, `stable`, and `preview <branch>` (or
  `preview --deployment <name>`) for a Preview.
- `up`, `down`, `restart`, and `logs` without a Target act on `working`;
  `deploy` without one deploys `stable`. A Preview is never a default. `rig
status` takes no Target.
- A Target must be on in `rig.yaml` (`targets.<name>: true` or a settings map;
  without a `targets` key every Target is off). `up`, `restart`, `deploy`, and
  `logs` of a never-run Target refuse an off one with `TARGET_OFF`, naming the
  line to add; `down`, `logs` and `status` still reach one that is off but
  recorded, and `doctor` names the line that turns it back on.
- `deploy` defaults `[branch]` to the Production branch for the stable Target
  and to the current Branch for `preview`. The stable Target accepts only the
  Production branch; `preview` refuses it.
- Deploying the Commit that is already deployed does nothing without `--force`.
- `--project` is needed only outside the Project's repository.
- Reads take `--json`; actions do not. `list`, `status`, `doctor`, `config`,
  `monitor`, `proxy`, `proxy verify`, `dns list` and `backup list` print one
  JSON document;
  `activity` and `logs` print JSON Lines, one record per line, for a file a
  program reads record by record. An action (`deploy`, `up`, `down`,
  `restart`, `run`, `backup restore` and the rest) answers with its exit code
  and a line saying what it did.
- `activity` and `logs` print a bounded number of records (20 and 50 by
  default) and say on stderr when they left matching ones out, such as
  `showing 20 of 340 records; --lines or --until to see more`, so stdout redirected to a
  file holds only the records. `logs` shortens a line past 2,000 characters,
  ending it `… (61,440 more characters)` (in JSON, the entry's `omitted`);
  `--full` prints it whole.
- `run` starts one run of a job from `jobs` in `rig.yaml` and answers once it
  started; it never waits for the run to end. Without a Target it means
  `stable`, where jobs are scheduled by default; it runs the job in any Target
  that is on and deployed, whatever the job's `targets` schedule. It is refused with `JOB_RUNNING` while a
  run of the job is going (runs never overlap), with `JOB_UNKNOWN` for a job the
  Target's plan does not have (the hint names the jobs it has, or the command
  that plans it again), with `JOB_UNAVAILABLE` for a stopped Target, and with
  `TARGET_OFF` for an off Target. `down` and `down --destroy` fail with
  `JOB_STOP_UNVERIFIED` when a job run cannot be confirmed stopped; `down`
  still stops the Services first, and `--destroy` changes nothing. `down` withholds
  the Target's routed paths before it stops anything, so its hostnames answer
  `503` and never reach a program that takes a freed port; when Rig's Caddy
  cannot be made to, `down` stops nothing and fails `ROUTE_WITHHOLD`. `status` lists each
  Target's jobs with their last and next run, `activity` has one `job` entry
  per ended run, and `logs --service <job>` reads a job's output.
- `backup list` and `backup restore` work on backup jobs (`backup:` under a
  job, ADR 0017). `run` of a backup job makes a backup as the schedule does.
  `backup restore` resolves `latest`, asks for confirmation unless `--yes`
  (refused with `RESTORE_CONFIRMATION` without a terminal), starts the job's
  `restore` command as a run of the job, and waits for it to end: it exits 1
  with `RESTORE_FAILED` unless it succeeded, and Ctrl-C stops only the wait.
  It is refused with `JOB_RUNNING` while a run or restore of the job goes,
  `BACKUP_NO_RESTORE` for a job without `restore`, `BACKUP_NOT_CONFIGURED`
  for a job without `backup`, `BACKUP_UNKNOWN` for an id that is not kept,
  `BACKUP_EXPIRED` for one the retention of a run that just ended let go, and
  `BACKUP_MISSING` for a backup whose directory was deleted. It never stops
  Services.
- `status` runs no health check for a Service with a `healthcheck`: it shows
  the result `rigd`'s ongoing checks cached, such as
  `web  healthy · checked 12s ago` or
  `api  unhealthy 3/3 · HTTP 503 · restarted 1 time`. `doctor` reports an
  unhealthy Service from the same result. Becoming unhealthy, becoming
  healthy again, and each health restart are in `rig activity`.
- `--destroy` is its own confirmation; there is no prompt and no `--yes`.
- `forget` withdraws every route the Project's Targets publish before it drops
  the registration. When one cannot be withdrawn it is refused with the proxy's
  code (`PROXY_UNREACHABLE`, `ROUTE_RELOAD`, …) and changes nothing; run it
  again once the hint's fix is done. A route whose Target no longer exists is
  withdrawn when rigd starts, before a `deploy`, `up` or `restart` publishes a
  route, and by `rig proxy reload`; `doctor` names one as `route-owners`. When
  `providers.caddy.caddyfile` puts the route file outside `RIG_ROOT`, where
  another root may write too, only `rig proxy reload` withdraws them.
- `forget` leaves the Project's Tools in `<RIG_ROOT>/bin`, where they keep
  running, and names them in a warning. Dropping the registration releases
  them: the next `deploy`, `up` or `restart` that publishes a Tool of the same
  name, from any Project (`rig` and `rigd`: only the repository that published
  them, identified by its root commits), replaces it,
  unless its bytes changed since Rig published it (`ARTIFACT_CHANGED`; move or
  delete the file, except `rig` and `rigd`: never move or delete those, but put
  back the bytes Rig recorded by renaming a copy over them). `doctor` names a Tool whose Target no longer exists as
  `tool-owners`, failing only for a changed one.
- `logs --service` takes a Service, Tool or job name from `rig.yaml`, or `setup`
  for dependency installation; an unknown name fails as `USAGE` and lists the
  Target's names. `--since` and `--until` are inclusive, and leave out lines
  with no recorded time (the files launchd wrote for a job under an older
  Rig). A time is a duration back from now (`90s`, `15m`, `1h`, `2d`, `1w`, or
  combined as `1h30m`) or an ISO time with a zone (`2026-09-28T03:00:00Z`,
  `2026-09-28T05:00:00+02:00`). How much history exists to filter depends on
  the Host `logs` settings (see the guide's Logs section).
- `init` writes one Service (`--service` with `--command`) or one Tool (`--tool`
  with `--bin`). The Service gets one port, `http`, so a `--domain` routes to it
  without a `proxy` line, and `--healthcheck` becomes its `healthcheck.test` (the
  old `--ready` is refused with that hint). A Tool's `bin` is the executable's path inside the
  repository; Rig copies it into `<RIG_ROOT>/bin` as `<tool>` for the stable
  Target, `<tool>-dev` for the working Target and `<tool>-<preview name>` for a
  Preview, so it must be
  self-contained or name its checkout itself (`dirname "$0"` is
  `<RIG_ROOT>/bin`). A source file (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`,
  `.cjs`) is published instead as a shim that runs it in place with the bun
  `rigd install` recorded, so its relative imports resolve.
- `RIG_ROOT` is the only environment switch: an absolute path, `~/.rig` by
  default. There are no `--state-root` or `--config` overrides.
