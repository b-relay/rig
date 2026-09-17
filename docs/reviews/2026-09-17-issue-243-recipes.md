# Issue #243 run notes — recipes as ordinary config

Branch `feat/issue-243-recipes`, PR against `feat/issue-114-config-cutover`.
No runtime was installed and no live daemon, job, route or data was touched; every
test runs in a temporary directory, and no test starts a real database.

## What changed

- `rig recipe list`, `rig recipe generate <recipe[@version]> [--name <service>]`
  and `rig recipe diff [service] [--project <name>]`.
- Two bundled recipes, `postgres@1` and `convex@1` (`src/recipes/catalog.ts`).
  Each version is a function of the Service name that returns a plain Service
  value; the block is that value stringified beneath its provenance comment.
- Provenance is a YAML comment directly above the Service key:
  `# rig-recipe: <recipe>@<version> name=<service>`. The config reader parses
  it from the same bytes as the config into `ConfigDocument.recipeMarkers`
  (absent when there are none). Planning and running never read it.
- `rig recipe diff` is a daemon read (`recipe-diff`, optional `serviceName`). It
  is three-way and field-level: bundled@marked → bundled@latest (`update`) and
  bundled@marked → the user's Service (`customized`). Both sides pass through
  the config parser.
- `DoctorReport.notices?: string[]`: advisories that change neither `ok` nor
  the exit code, computed from the document doctor already read (still one
  read). Outdated version, unknown recipe, unknown version, malformed comment.
  A block at the bundled version is not mentioned, customized or not.
- The accepted multi-Service example carried an illustrative comment the reader
  would call malformed; it now carries the form Rig writes, and a test holds
  its `db` equal to `postgres@1`.

## Decisions

**Where provenance lives.** A, chosen: a comment. B, rejected: a schema key
(`services.db.recipe`). The schema is strict, so a malformed value would make
the whole Project unreadable over something that must never matter to a run; it
would be a second config input every planner has to remember to ignore; and the
ticket says generated Services are ordinary config. A comment cannot affect the
plan by construction, survives structured edits (tested), and deleting it
degrades to "nothing to compare".

**How a block reaches rig.yaml.** A, chosen: `generate` prints; the user pastes.
B, rejected: insert into `rig.yaml`. The structured editor cannot attach
comments, inserting into a flow-style `services` map re-emits it, and it would
be a new mutation surface for a one-time paste. Printing needs no `rigd`, no
Project, no lock, and cannot damage a file.

**Where diff runs.** In `rigd`, as a read action, because `--project` selection
and the single validated document acquisition live there. `list`/`generate`
are CLI-local because they read nothing but the catalog.

**Notices, not checks.** A doctor check has pass/fail and affects `ok`. An
available update is neither. A separate `notices` list keeps "No problems
found." true.

**Catalog injection.** `CliDependencies.recipes` and
`RuntimeDependencies.recipes` default to `BUNDLED_RECIPES`. No bundled recipe
has a second version yet, so update/diff behaviour is tested with an injected
two-version `cache` recipe through the same public paths.

## Known limits

- Convex: the Convex CLI chooses its own local backend state directory (under
  the user's home), and offers no option for it, so the recipe cannot put it in
  `${rig.data}` and says so in its summary and in the guide. The recipe is
  carried over from the removed plugin's command line (f6d48fe~1) and was not
  run against a real Convex install here.
- PostgreSQL: the generated command was executed with stub `initdb`/`postgres`
  programs to show the argument and environment mapping; no real cluster was
  created. `--auth=trust` is loopback-only local development policy.
- The offline doctor (no `rigd`) does not compute notices.
- A comment separated from its key by a blank line, or placed inside a
  flow-style `services` map, is not provenance. Several `rig-recipe` comments
  above one key are reported as malformed rather than guessed between.
- A list field is one value in the diff.

## Function-design ledger (findings only)

| Function | Finding | Resolution |
| --- | --- | --- |
| `recipeMarkers(document, raw)` | Pure over the parsed AST and the bytes it was parsed from; taking both keeps one acquisition. Never throws: anything unrecognized is `malformed`. | Called only inside `decodeDocument`. |
| `compareRecipes(document, catalog)` | Pure. Preserves every distinction the renderer and doctor act on: malformed / unknown-recipe / unknown-version / compared. | — |
| `recipeReport` | Two refusals a caller separates: `SERVICE_UNKNOWN`, `RECIPE_UNMARKED`. A Project with no marked Service is an empty report, not an error. | — |
| `recipeNotices` | Pure projection of findings; one owner of notice wording. | — |
| `renderRecipe` | Pure; the comment text has one owner (`markerComment`) beside its reader. | — |
| `addRecipeCommands` | Takes `projectScope` as a parameter because importing it would make `commands.ts` and this file import each other. | Named here as the reason for the parameter. |
| `buildDoctorReport` | Gains one output (`notices`), no new read. | Existing single-read test still passes. |

## Evidence

- Red: with `src/cli/commands.ts` at HEAD, four of the recipe tests fail at
  `expect(code).toBe(0)` (unknown command); with `src/runtime/doctor.ts` at
  HEAD, the two doctor-notice tests fail at the notice text. Restored, all pass.
- `tests/recipes.test.ts` (6): real CLI over a real runtime, the real config
  reader and file state in a temporary repository. Renamed block parses and
  resolves; older customized block diffs three ways; doctor notice with exit 0;
  every bundled recipe under two names resolves for the working, stable and
  preview roles with no unresolved reference,
  no wildcard address and no prepared component; refusals for unknown recipe,
  version and Service name print nothing to stdout; the PostgreSQL command run
  twice with stub programs initializes once and listens on 127.0.0.1; the
  findings matrix (current, customized, renamed key, unknown version, unknown
  recipe, malformed, doubled comment, unmarked, unknown Service) with config
  bytes unchanged and every Service still planned; comment survives
  `editProjectConfig`; the accepted example equals `postgres@1`.
- `tests/cli-grammar.test.ts`: `recipe diff` is one read request; `list` and
  `generate` send none. `src/cli/cli.test.ts`: `--help`/`-h` for all four.
- `bun run typecheck`, `bun run build`: clean. Full `bun test`: see the PR body.

## Handoff

- **#244**: migration may emit the comment form above for Services it converts
  from the old plugins, or none; nothing requires it.
- **#245** gate: recipes add no runtime dependency. Evidence is
  `tests/recipes.test.ts`; a live PostgreSQL/Convex run was not performed.
