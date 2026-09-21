# Rig Command Reference

Every command, argument, and flag of `rig`, `rigd`, and `git-remote-rig`. The
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
│
├─ logs [target] [branch]
│    --project <name>   --deployment <name>
│    --follow                       stream until interrupted
│    --lines <count>                default 50, at most 10000
│
├─ rename <name>                    new identity; the Project must be stopped
│    --project <name>               current identity
├─ repoint <path>                   new repository path; the Project must be stopped
│    --project <name>
├─ forget <name>                    drop a stopped Project's registration
│
├─ recipe
│    ├─ list                        bundled recipes and their versions
│    ├─ generate <recipe>           name or name@version; prints a Service block
│    │    --name <service>
│    └─ diff [service]              compare generated Services to their recipes
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
not give Rig.

## git-remote-rig

```
git-remote-rig <remote> [rig://localhost/<project>]
```

Git runs this helper for `git push rig <branch>`. People never run it.

## Behavior The Tree Does Not Show

- Target names are `local` (Working copy) and `live` (Stable) unless `rig.yaml`
  renames them. A Preview is always selected as `preview <branch>`.
- `up`, `down`, `restart`, and `logs` without a Target show a picker in a
  terminal and fail as `TARGET_REQUIRED` otherwise. `rig deploy` without a
  Target prints help. `rig status` takes no Target.
- `deploy` defaults `[branch]` to the Production branch for the Stable Target
  and to the current Branch for `preview`. The Stable Target accepts only the
  Production branch; `preview` refuses it.
- `git push rig <production branch>` deploys the Stable Target; any other
  Branch deploys a Preview. A push has no `--no-up`.
- Deploying the Commit that is already deployed does nothing without `--force`.
- `--project` is needed only outside the Project's repository.
- `--json` exists on `status`, `deploy`, `up`, `down`, and `restart` only.
- `--destroy` is its own confirmation; there is no prompt and no `--yes`.
- `init` writes one Service (`--service` with `--run`) or one Tool (`--tool`
  with `--bin`). A Tool's `bin` is the executable's path inside the
  repository; Rig copies it into `<RIG_ROOT>/bin` as `<tool>` for the Stable
  Target and `<tool>-<target name>` for the others.
- `RIG_ROOT` is the only environment switch: an absolute path, `~/.rig` by
  default. There are no `--state-root` or `--config` overrides.
