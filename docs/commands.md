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
│    --domain <domain>              Stable Target domain; Previews get subdomains
│    --service <name>  --run <command>  --port <port>  --ready <check>
│    --tool <name>     --bin <path>     --tool-build <command>
│
├─ list                             all Projects on this Host
├─ status                           all Targets of one Project
│    --project <name>   --json
├─ doctor                           Host checks, plus Project checks when in one
│    --project <name>
├─ config                           show the validated rig.yaml and its path
│    --project <name>
│    └─ upgrade                     rewrite rig.yaml in the latest format, keeping comments and layout
│         --project <name>
│         --dry-run                 print the diff without writing
├─ activity [operation]             the latest 100 actions, or one Operation by id
│
├─ deploy [target] [branch]         target: the Stable Target's name, or "preview"
│    --project <name>
│    --force                        redeploy the same Commit
│    --no-up                        deploy without starting
│    --deployment <name>            explicit Preview name
│    --json
│
├─ up      [target] [branch]        target: a Target name, or "preview"
├─ restart [target] [branch]
├─ down    [target] [branch]
│    --project <name>   --deployment <name>   --json
│    --destroy                      down only: delete a Preview and its own data
│    --kill                         down and restart: skip stop_timeout (SIGTERM, SIGKILL after 1.5 s),
│                                   and cut short a stop already running on the Target
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
├─ recipe
│    ├─ list                        bundled recipes and their versions
│    ├─ generate <recipe>           name or name@version; prints a Service block,
│    │                              and writes the recipe's files, if any
│    │    --name <service>
│    │    --format <format>         rig/v1 or rig/v2 (default: the nearby rig.yaml's, else rig/v2)
│    └─ diff [service]              compare generated Services (and recipe files)
│                                   to their recipes
│         --project <name>
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

`rigd capture` is not a user command. Under the `launchd` supervisor, launchd
runs `rigd capture <request-file>` for each Service instead of the Service's
own command. The wrapper starts the Service as its child, writes its output to
the Target logs, and records its status and exit, which launchd alone would
not give Rig. The request file is a small JSON document `rigd` writes for that
Service: its command, working directory, environment, and log directory.

## Behavior The Tree Does Not Show

- Target names are `local` (Working copy) and `live` (Stable) unless `rig.yaml`
  renames them. A Preview is always selected as `preview <branch>`.
- `up`, `down`, `restart`, and `logs` without a Target show a picker in a
  terminal and fail as `TARGET_REQUIRED` otherwise. `rig deploy` without a
  Target prints help. `rig status` takes no Target.
- `deploy` defaults `[branch]` to the Production branch for the Stable Target
  and to the current Branch for `preview`. The Stable Target accepts only the
  Production branch; `preview` refuses it.
- Deploying the Commit that is already deployed does nothing without `--force`.
- `--project` is needed only outside the Project's repository.
- `--json` exists on `status`, `deploy`, `up`, `down`, and `restart` only.
- `--destroy` is its own confirmation; there is no prompt and no `--yes`.
- `logs --service` takes a Service or Tool name from `rig.yaml`, or `setup`
  for dependency installation; an unknown name fails as `USAGE` and lists the
  Target's names. `--since` and `--until` are inclusive, and leave out lines
  with no recorded time (the files launchd writes for a job). A time is a
  duration back from now (`90s`, `15m`, `1h`, `2d`, `1w`, or combined as
  `1h30m`) or an ISO time with a zone (`2026-09-28T03:00:00Z`,
  `2026-09-28T05:00:00+02:00`). How much history exists to filter depends on
  the Host `logs` settings (see the guide's Logs section).
- `init` writes one Service (`--service` with `--run`) or one Tool (`--tool`
  with `--bin`). A Tool's `bin` is the executable's path inside the
  repository; Rig copies it into `<RIG_ROOT>/bin` as `<tool>` for the Stable
  Target and `<tool>-<target name>` for the others, so it must be
  self-contained or name its checkout itself (`dirname "$0"` is
  `<RIG_ROOT>/bin`). A source file (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`,
  `.cjs`) is published instead as a shim that runs it in place with the bun
  `rigd install` recorded, so its relative imports resolve.
- `rig init` writes `rig.yaml` in the latest format, `rig/v2`. Every command
  run in a Project whose `rig.yaml` is the older `rig/v1` (a file without
  `format`) prints one `Deprecated:` line on stderr naming
  `rig config upgrade`, as does a deploy of a Commit whose `rig.yaml` is
  `rig/v1`. `rig config upgrade` changes only the file in the working tree;
  commit it yourself.
- `rig status` shows a Service with `health.interval` by its last ongoing
  check (`healthy · checked 12s ago`, `unhealthy 2/3 · <output>`) without
  running the check; others are checked when status runs.
- `RIG_ROOT` is the only environment switch: an absolute path, `~/.rig` by
  default. There are no `--state-root` or `--config` overrides.
