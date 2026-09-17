# Issue #239 run notes — selected-Target references and process environments

Branch `feat/issue-239-target-inputs`, for the #114 integration branch
`feat/issue-114-config-cutover`. Nothing here was installed or run against a
live daemon; every test uses an isolated `RIG_ROOT` and operator home.

## What changed

- `src/config/references.ts` (new, pure): `${...}` is an exact path to a
  scalar in the selected Target's patched settings, or `rig.target`,
  `rig.workspace`, `rig.data`, `rig.host`, `rig.url`. Values resolve
  recursively. Refusals: `unknown_reference`, `reference_not_scalar`,
  `reference_into_targets`, `reference_cycle`, `invalid_context` (`rig.data`
  outside a Service). `$${VAR}` yields a literal `${VAR}`; `$VAR` is untouched.
  Every resolved string reports the public env leaves it was built from,
  directly or transitively (`PublicInput {name, source, value}`).
- `src/config/schema.ts`: a dry run of the resolver over the base settings and
  each role's patched settings reports reference issues at parse time, at the
  path of the field that holds the reference.
- `src/config/resolve.ts`: `resolveTargetPlan(input, host)` takes
  `ResolveHost {operatorHome, envRoot}`. Each Component records ordered
  `envFiles` (`{path, required}`: listed files required, then the operator
  convention files `<envRoot>/<project>[/<service>]/{all,<role>}.env`
  optional) and `commandInputs` (the leaves its run/build/shell-ready text
  used). A Service gets Project then Service layers; a Tool and the Project
  scope get Project layers only. `~/` paths resolve against the operator home;
  `~user` is `invalid_path`.
- `src/domain/process-environment.ts` (new, pure): `composeEnvironment`
  layers baseline < public env < files in order, reports overrides by name and
  source, and throws `ENV_CONFLICT` when the final file value of a guarded
  leaf differs from the value the command was built from.
- `src/adapters/env-file.ts`: `loadEnvironmentFiles` reads the recorded files
  fresh, skips absent optional files, refuses a file inside the workspace Git
  does not ignore (`ENV_FILE_TRACKED`), and warns on group/other permissions.
  The `ENV_FILE_MISSING` hint no longer suggests committing the file.
- `src/adapters/target-effects.ts`: every invocation's environment is composed
  fresh from `executionBaseline` (PATH, HOME, LANG, LC_ALL, LC_CTYPE, TZ) plus
  a Target-owned `TMPDIR` (mode 700). Override notes and permission warnings
  go to the Target log once per adapter, by name and path only. Build receipts
  key on public env and env file paths, never on file contents.
- `PORT_RESERVED` names the owning Target and Project and says the guarantee
  covers Rig's own Targets only (`portOwners` replaces `occupiedPorts`; the
  `selectPorts` contract takes the owner map, so the conflict has one owner).

## First regression

`tests/target-inputs.test.ts`, first two tests: a Working copy whose `run`
reaches Project `env.DB_NAME` through `services.api.env.DATABASE_URL`, an
operator `working.env`, and an ordinary `serve.sh` that checks its argv and
env and knows nothing about Rig.

- Red (before the change): `ConfigError: Unknown reference
'${services.api.env.DATABASE_URL}' in services.api.run.`
  (`unknown_reference`) — the old resolver had no settings paths, the expected
  reason.
- Green: a differing file value is refused as `ENV_CONFLICT` with
  `{key, component, sources}`, no value anywhere, and no `/bin/sh` invocation;
  an equal value plus a file-only secret runs `./serve.sh --db db://app/main`
  to `pass`, the same executable passes when run by hand with the same inputs,
  and the secret is absent from the serialized plan.

Further tests: six-layer precedence and scope isolation, role file by role
rather than display name, fresh read on the next invocation without touching
the plan, required versus optional files, `ENV_FILE_TRACKED` and the single
permission warning, `composeEnvironment` and `executionBaseline` units
(`tests/process-environment.test.ts`), reference refusals and transitive
inputs and `~` paths (`tests/config.test.ts`), receipt stability when a file's
contents change (`tests/target-effects.test.ts`), and the named port owner
(`tests/runtime-application.test.ts`).

## Function-design ledgers (findings only)

- `referenceResolver(settings, generated)`: plain path, pure. Generated values
  are a parameter, so the parse-time dry run and real resolution share one
  implementation. Five refusals stay distinct because the author fixes each
  differently. Scope comes from the `at` path, so a caller cannot resolve a
  Service value in the wrong Service.
- `composeEnvironment(input)`: plain path, pure. Result is data (`env`,
  `overrides`); the adapter owns logging. One failure, `ENV_CONFLICT`, decided
  here because only here are the guarded leaves and final file values both
  known. It compares by leaf name and provenance, not by string equality with
  the command text, so a coincidentally equal string under another name is
  never a conflict.
- `loadEnvironmentFiles(refs, workspace, ignored)`: full path. Ambient: file
  reads and `stat`; Git is a passed provider (`IgnoredByGit`), built once by
  the adapter from its command runner. Failures: `ENV_FILE_MISSING`
  (required only), `ENV_FILE_TRACKED`, `ENV_FILE` (parse). When Git cannot
  answer (not a repository), the file loads: the rule protects repositories.
- `environment(target, component?)` in target-effects: effect owner. Reads
  files, creates the TMPDIR, writes notes to the Target log. The note dedupe
  set is adapter state, stated in its comment.
- `resolveTargetPlan(input, host)`: the operator home and env root were
  ambient candidates (`homedir()`, `RIG_ROOT`); they are a parameter filled by
  the composition root, and relative values are refused as `relative_root`.
- `selectPorts({occupied})`: the parameter became the owner map rather than a
  second lookup in `planTarget`, so the adapter that detects the conflict also
  names the owner.

## Review (Codex, gpt-6-astra, high, read-only; one session for this PR)

Round 1 found five items.

- Fixed: substituted values are literal data in every shell context (bare,
  double-quoted, single-quoted), and an empty bare value keeps its argument;
  proven through real child argv.
- Fixed: a `ready` value that resolves to an HTTP URL is not shell-quoted and
  guards no inputs.
- Fixed: a Git failure other than "not a repository" is `ENV_FILE_UNVERIFIED`
  instead of loading the file unchecked.
- Handed to #241: the rigd and launchd supervisors persist the request they
  were given, environment included, in a 0600 lease/capture file and the
  launchd plist, so that they can restart a process without the daemon. That
  predates this ticket and is the supervisors' restart contract; #241 owns
  "saved policy and fresh env-file behavior" for both supervisors and must
  replace the stored environment with recomposition at restart. The public
  plan, state, receipts, errors and Target logs written here carry no file
  value.

Round 2 accepted the #241 handoff and left two items, both fixed.

- A reference inside `$(...)` or `(...)` is quoted for that inner command,
  not for the quote around it; a reference inside backquotes is refused as
  `invalid_context` with a hint to use `$(...)`. Proven through child argv.
- Spec Q20 ("Service-specific environment/data references cannot be used in a
  Project or Tool build"): the shared `build` and a Tool `build` refuse a
  Service `env` leaf or `rig.data`, reached directly or through another
  value, as `invalid_context` naming the build and the path it came through.
  A leaf still resolves in its declaring Service's scope for Service
  consumers.

## Remaining dependencies

- #240: shared `build`, Service `build` and `workdir` are still
  `unsupported_setting`; their references are already validated and their
  `commandInputs` rule is in place for Tool builds.
- #241: restart policy. The restart recheck here is structural: every start
  composes the environment again.
- #242: Services with no port or several ports.
- #244: `src/migration/convert.ts` and `src/migration/schema.ts` still emit
  the old `envFile` plan field; migration owns moving recorded plans to
  `envFiles`. State written by this branch uses `envFiles` only.
- Inherited: `INHERITED_VARIABLES` stays for the daemon's own tooling (Git
  discovery, proxy inspection, the launchd plist); applications no longer use
  it.
