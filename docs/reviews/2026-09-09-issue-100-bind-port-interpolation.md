# Issue #100: localhost bind port interpolation

The raw command schema now replaces interpolation expressions with a numeric
placeholder solely for bind validation. Commands such as
`serve --addr 127.0.0.1:${server.port}` retain their original text in parsed config
and resolve to the selected port. Literal non-local hosts still fail immediately;
actual resolved values still pass through the unchanged `localhostCommand` check.

## Contract and design

Compared removing schema validation with substituting placeholders at the raw
schema boundary. Chose substitution: it preserves early rejection of literal
non-local hosts without weakening the validator used after interpolation. No
module/provider interface changes. Before and after, callers use
`parseProjectConfig(raw)` followed by `resolveTargetPlan(input)`; only acceptance
of raw localhost port templates changes.

The changed refinement callback takes one borrowed command string, returns a
boolean, retains/mutates nothing, and has no ambient access, effects, or expected
throws. Its prerequisite is the existing nonempty-string Zod check. Standard
String.replace and the existing tested localhostCommand predicate are trusted
pure callees. Zod owns validation failure collection and parseProjectConfig owns
the tagged ConfigError. The callback performs one domain job: validate the raw
command with unresolved expressions represented as numbers. Binding policy stays
owned by localhostCommand; the schema alone owns placeholder substitution.

Existing regex tokenization is inherited debt: this is not a shell parser or a
complete inventory of application-specific flags. Host interpolation remains
rejected. Unknown interpolation names retain resolver errors. No new self alias
is introduced; the working resolver syntax is `${server.port}` for component
`server`. Tests cover public parse/resolution seams already authorized by the
supervisor handoff, with no private function tests or mocks. Empty commands remain
rejected by the unchanged nonempty-string schema; no result streaming, mutation,
partial progress, or effect failure channel exists in this callback.

## Evidence

- Red: the public parse/resolution regression failed with ConfigError and
  `Explicit network bindings must use 127.0.0.1 or localhost.` before the edit.
  An initial missing YAML dependency was resolved by linking the existing
  checkout node_modules before capturing the actual red failure.
- Green: the same regression resolved to `serve --addr 127.0.0.1:3210`.
- Expanded coverage: 127.0.0.1, localhost, equals and quoted flag values, literal
  ports, wildcard/remote hosts with interpolated ports, rejected host templates,
  and a placeholder resolving to a non-port path rejected by the real resolver.
- `RIG_ROOT=/tmp/rig-issue-100-tests/.rig bun test tests/config.test.ts`:
  32 pass, 0 fail, 84 assertions.
- `RIG_ROOT=/tmp/rig-issue-100-tests/.rig bun run typecheck`: passed.
- Full gate and independent review belong to the parent supervisor. No live
  runtime, listener, launchd, Caddy, or user state was changed.
