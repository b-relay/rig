# Configuration rewrite contract evidence

Scope: `src/config/**` and `tests/config.test.ts`. The public Interface is the
config module export; tests read, initialize, discover, edit, validate, and
resolve configuration through that Interface. Filesystem access lives in the
configuration document Adapter. Resolution does not read the environment,
filesystem, clock, network, or process state.

## Interface choice

Compared a representation-centric Interface exposing a parsed YAML AST plus
per-field readers against a document-and-plan Interface. Selected the latter:
callers receive validated config with source path/format/revision, or a complete
Target plan. YAML restrictions, discovery, editing policy, interpolation,
Component kind policy, and dependency ordering have Locality inside one Module.
The AST is private. No public parser-library objects reach runtime callers.

## Effect ledgers

Each row is a full-path function ledger. The filesystem Adapter owns expected
filesystem failures and config-specific failure distinctions. Node filesystem
and YAML/Zod contracts are established by integration tests crossing the public
Interface, including the existing checked-in full-stack JSON fixture.

| Function | Inputs / prerequisites | Outputs and effects | Ambient access / direct callees / failure owner |
|---|---|---|---|
| `locateConfig` | Caller directory and scope stem; directory may be absent | Selected path, absence, ambiguity, or read failure | Reads filesystem metadata using Node `access`; handles only ENOENT as absence, preserves other failures as ConfigError. Both names are probed before selection. |
| `readDocument` | Selected source path and pure validator | Materialized ConfigDocument or parse/validation/read failure | Node `readFile` reads caller-selected file; pure `decodeDocument` validates bytes. No mutation or fallback. Config Adapter owns the failure distinction. |
| `readProjectConfig` | Caller repository path | Validated source document or missing/ambiguous/invalid error | Calls `locateConfig`, `readDocument`; inherits their bounded filesystem reads. No current-directory acquisition. |
| `discoverProject` | Existing caller path, which can name a directory or file | Canonical repository directory and validated document or absence/error | Node realpath/stat and upward canonical-name probes. Stops at the first config, including its errors; never skips an invalid closer document. |
| `readHostConfig` | Caller state root | Fully defaulted Host config | Calls canonical-name probe/read; defaults only when both files are absent. Read/parse/ambiguity failures remain failures. |
| `initializeProjectConfig` | Repository path and complete initialization intent | Exclusive new YAML write, then source readback; existing file failure | Node writeFile with wx after both-name probe; `scaffoldProjectConfig` validates before write. Never renames, migrates, or overwrites JSON. |
| `editProjectConfig` | Repository, expected content revision, field edits; callers retry stale revisions explicitly | Updated source document and backup path; exclusive lock, content-addressed backup, temporary file, atomic rename | Node open/read/write/stat/rename/unlink and random UUID temporary naming; pure AST edits and domain validation precede replacement. Adapter owns stale/locked/lossy/invalid outcomes. Finally releases owned lock/temp resources. Cooperating Rig writers serialize. External editors are checked again before replacement but do not participate in the lock. |

`decodeDocument` accepts a pure validator whose failure is ConfigError. Its output
is owned materialized data; the YAML syntax tree never escapes. The selected
format, complete source bytes, and validator determine every outcome.
`yamlDocument` rejects multi-document input, YAML versions other than 1.2,
parser errors/warnings, duplicate keys, explicit tags, anchors, aliases, and
merge keys before domain conversion.

## Pure-function contract checks

- `revisionOf` maps exact source bytes to a SHA-256 revision. Empty bytes have a
  revision but cannot pass config validation. No rejected hash input channel.
- `missing` preserves the distinction between filesystem absence and all other
  failures; only ENOENT is absence.
- `validateEditPath` rejects empty paths and prototype-mutating segments; callers
  use accepted paths only for the stated source edits.
- `scaffoldProjectConfig` accepts initialization intent and returns validated
  portable policy. Duplicate initial names fail; it has no Git or disk effects.
- `localhostCommand` examines explicit bindings while allowing remote URLs used
  as command arguments. Local health URL validation is stricter than command URL
  validation. The checked-in fixture establishes interpolation compatibility.
- `parseProjectConfig` and `parseHostConfig` return validated owned data or
  ConfigError containing safe path/message details. They never return source
  contents in error metadata. Strict schemas reject unsupported fields.
- `interpolate` accepts a string and the complete property map. Unknown keys
  fail with their key, rather than becoming empty strings. No ambient environment
  expansion is performed by the resolver.
- `resolveHooks` preserves the absent/present distinction and interpolates each
  provided hook from the same Target properties. No hook executes here.
- `dependencyOrder` returns every Component once, after its dependencies. It
  receives definitions whose references and cycles have been validated. Empty
  input returns an empty plan; no provider or process is consulted.
- `resolveComponentProperties` selects caller-assigned/configured ports,
  rejects missing/out-of-range/colliding ports, and returns prepared storage
  properties. Preview assigned ports take precedence. Other Targets prefer
  configured ports. It owns an internal, deterministic port map, not OS sockets.
- `resolvePlanComponent` consumes one Component, its shared definition, Target
  overrides, workspace, and resolved properties. It returns a discriminated
  managed/installed/persistent result including env, hooks, dependencies, and
  readiness policy; it does not execute commands or prepare storage.
- `resolveTargetPlan` validates Project policy, resolves Target properties,
  resolves every Component, orders dependencies, and returns the complete plan.
  Caller-owned Branch/Commit identity and paths are preserved. Providers consume
  the plan; the resolver never reaches into providers.

## Verified behavioral channels

Sixteen tests and 56 assertions pass with `bun test tests/config.test.ts`.
The initial read and plan tests failed because their public operations did not
exist. Subsequent regression tests demonstrated then corrected missing shared
environment variables, interpolation health-URL rejection, initialization
options being ignored, lossy YAML map replacement, YAML 1.1 acceptance, and temporary-file ownership.
Config source files have no TypeScript diagnostics in the current full-project
compiler output. Formatting used cached Prettier 3.9.6 on owned paths only.

Coverage includes valid YAML comments, supported JSON, upward discovery,
ambiguity, missing Host defaults, invalid YAML, source-format preservation,
revision conflicts, retained comments/order, unchanged invalid edit source,
backup readback, bounded source/field validation hints, inherited-property rejection, localhost binding checks, invalid override kinds, missing and
cyclic dependencies, ordinary and Preview plans, installed tools, persistent
SQLite, Convex/Postgres defaults, forward interpolation, port collisions,
merged environment, and the existing full-stack fixture.

Material limitations: replacing YAML mappings/sequences refuses safely; use
individual field edits. No promise of atomic compare-and-swap against unrelated
external editors is made. Runtime callers own port reservation, process and
filesystem capability checks, and plugin preparation effects.
