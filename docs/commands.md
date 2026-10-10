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
├─ status                           all Targets of one Project
│    --project <name>   --json
├─ doctor                           Host checks, plus Project checks when in one
│    --project <name>
├─ config                           show the validated rig.yaml and its path
│    --project <name>
├─ activity [operation]             the latest 100 actions, or one Operation by id
│
├─ deploy [target] [branch]         target: "stable" (default) or "preview"
│    --project <name>
│    --force                        redeploy the same Commit
│    --no-up                        deploy without starting
│    --deployment <name>            explicit Preview name
│    --json
│
├─ up      [target] [branch]        target: "working" (default), "stable" or "preview"
├─ restart [target] [branch]
├─ down    [target] [branch]
│    --project <name>   --deployment <name>   --json
│    --destroy                      down only: delete a Preview and its own data
│    --kill                         down and restart: skip stop_timeout (SIGTERM, SIGKILL after 1.5 s),
│                                   and cut short a stop already running on the Target
│
├─ run <job> [target] [branch]      start a scheduled job now; target: "stable" (default), "working" or "preview"
│    --project <name>   --deployment <name>   --json
│
├─ logs [target] [branch]
│    --project <name>   --deployment <name>
│    --follow                       stream until interrupted, after the matching history
│    --lines <count>                default 50, at most 10000, counted after filtering
│    --service <name>               only this Service's or Tool's lines; repeatable
│    --stream stdout|stderr         only this stream
│    --since <time>  --until <time> 1h, 15m, 2d … back from now, or an ISO time with a zone;
│                                   --until cannot be combined with --follow
│
├─ rename <name>                    new identity; the Project must be stopped
│    --project <name>               current identity
├─ repoint <path>                   new repository path; the Project must be stopped
│    --project <name>
├─ forget <name>                    drop a stopped Project's registration
│
└─ help [command...]                for example: rig help deploy preview
```

## rigd

```
rigd
├─ install                          install and verify the daemon
├─ status                           installed, running, reachable
├─ uninstall                        refused while Targets run or await recovery
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
- `--json` exists on `status`, `deploy`, `up`, `down`, `restart`, and `run`
  only.
- `run` starts one run of a job from `jobs` in `rig.yaml` and answers once it
  started; it never waits for the run to end. Without a Target it means
  `stable`, where jobs run by default. It is refused with `JOB_RUNNING` while a
  run of the job is going (runs never overlap), with `JOB_UNKNOWN` for a job the
  Target's plan does not run (the hint names the jobs it runs, or the `targets`
  line to add), with `JOB_UNAVAILABLE` for a stopped Target, and with
  `TARGET_OFF` for an off Target. `status` lists each
  Target's jobs with their last and next run, `activity` has one `job` entry
  per ended run, and `logs --service <job>` reads a job's output.
- `status` runs no health check for a Service with a `healthcheck`: it shows
  the result `rigd`'s ongoing checks cached, such as
  `web  healthy · checked 12s ago` or
  `api  unhealthy 3/3 · HTTP 503 · restarted 1 time`. `doctor` reports an
  unhealthy Service from the same result. Becoming unhealthy, becoming
  healthy again, and each health restart are in `rig activity`.
- `--destroy` is its own confirmation; there is no prompt and no `--yes`.
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
