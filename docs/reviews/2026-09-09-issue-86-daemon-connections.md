# Issue #86 — shared daemon connection discovery

Base: `26dc6bbda815e1b68f8451720fb7cc86a1b98f50`.

## Interface decision

Before, CLI Status, CLI command, and Rig remote each read the address, interpreted
absence, read the token, and constructed `DaemonClient`. Doctor also acquired cwd
again after asynchronous work. After, each operation calls `connectDaemon(root)`;
its returned transport client owns the existing request/response validation.
`isDaemonUnavailable(error)` centralizes the missing/unreachable interpretation.
CLI `createCliClient(root, cwd)` owns Doctor policy and typed Status dispatch.
The executable captures cwd once and passes it to parsing and offline inspection.

Compared two concrete shapes:

1. A rediscovering client class with status/command/health methods would hide the
   sequence but duplicate the existing transport interface and add forwarding
   methods. It would also make the lifetime of acquired credentials less visible.
2. A per-operation acquisition function returns the existing transport client.
   This owns discovery, missing-address guidance, and authentication acquisition
   without another transport abstraction. A failure predicate shares the small
   connection classification while callers retain their response policy.

Selected shape 2. Deleting this module would restore acquisition knowledge in
three caller paths. There is no global cache, retry, health probe, new file-read
interface, or offline behavior in the remote. Address and token are read for each
Status/command, including follow-up CLI commands. The local transport remains
bound to 127.0.0.1 and uses its existing deadlines and Zod validation.

## Compatibility and failure policy

Missing address produces `DAEMON_MISSING` with the CLI's existing installation
message/hint; the remote now shares this equivalent actionable guidance instead
of its separate wording. Missing/empty/unreadable token retains the existing
`readDaemonToken` setup-missing tag and guidance. Consequently Doctor retains its
existing offline behavior for missing setup, including missing token. Rejected
credentials (`UNAUTHORIZED`), malformed response (`DAEMON_PROTOCOL`), and corrupt
metadata (`DAEMON_STATE`) propagate; they do not become offline Doctor results.
Unreachable transport permits Doctor's existing read-only inspection only.
All other commands propagate the same tagged failures. Remote final-result
validation remains owned by `runRemoteHelper`; acceptance is not deployment.

## Function contract ledger

| Function | Inputs / results | Mutation and effects | Failure / ownership / callee trust |
| --- | --- | --- | --- |
| `connectDaemon` | Explicit Host root; owned transport client retaining discovered port/token | Reads current Host address/token files; no network request or caller mutation | Missing address becomes tagged setup guidance. File errors propagate. `readDaemonAddress` and `readDaemonToken` are tested filesystem adapters; `DaemonClient` construction only retains values. Caller owns when to reacquire, module owns ordering and absence interpretation. |
| `isDaemonUnavailable` | Unknown error; boolean classification | None; no retained data | Trusted RigError class and fixed code comparison. Boolean is sufficient for the CLI fallback decision; original errors remain intact for propagation. |
| `createCliClient` and returned methods | Explicit root/captured cwd, then Status selection or RuntimeCommand; typed report or command result | Retains root/cwd values. Each call reads discovery and performs network I/O; Doctor may read Host/Project files. Does not mutate supplied requests. | `connectDaemon`, transport validation, and offline inspection are tested adapters. CLI alone decides offline policy; explicit repo path precedes captured cwd. Failures otherwise propagate unchanged. |
| CLI `main` | argv; exit code | Effect owner captures environment/root/cwd once, installs and removes signal handlers, composes terminal/output/diagnostics/client | Trusted existing CLI/output adapters retain their prior effects and reporting. `runRigCli` owns rendering and parser behavior; lazy client construction does not acquire daemon files. |
| Remote `main` and command closure | argv and Git protocol input; exit code / protocol output | Existing Git inspection, stdin/output/diagnostics effects; each command acquires fresh connection and performs network I/O | Existing helper/source adapters own Git validation and final deployment policy. Acquisition failures reach existing helper error rendering. No offline call exists. |
| New test callbacks and fixture handlers | Temporary roots, fixture generations/replies, requests | Create/remove only owned temporary files; bind and stop owned localhost servers; collect protocol output | Cleanup uses finally. Responses are independent literals; assertions exercise public acquisition, CLI client, and remote protocol interfaces. |

Inherited debt: token-file adapter intentionally conflates empty/unreadable tokens
with missing setup; changing that tag would change the established Doctor policy.
`DaemonClient.command` returns unknown for non-Status results, with final-result
interpretation remaining at each command owner. No new general transport policy
or daemon lifecycle changes were introduced.

## Validation evidence

- TDD red: `RIG_ROOT=/tmp/rig-86-red/.rig bun test tests/daemon-connection.test.ts`
  failed because the planned public acquisition module did not exist (0 pass,
  1 fail). First slice checks successive daemon addresses and credential rotation.
- First green: same focused test with `/tmp/rig-86-green/.rig`: 1 pass,
  4 assertions.
- Focused final: `RIG_ROOT=/tmp/rig-86-focused/.rig bun test
  tests/daemon-connection.test.ts tests/transport.test.ts
  tests/git-remote-helper.test.ts src/cli/cli.test.ts`: 24 pass, 0 fail,
  231 assertions.
- Existing offline integration: `RIG_ROOT=/tmp/rig-86-offline/.rig bun test
  tests/deployment-e2e.test.ts --test-name-pattern 'offline doctor'`: 1 pass,
  0 fail, 3 assertions. Fixture compiled its required CLI/daemon entrypoints.
- `bun run typecheck`: passes after `bun install --frozen-lockfile` restored
  this isolated worktree's dependencies. Initial missing commander/yaml errors
  were dependency setup, not source diagnostics.
- Existing CLI tests cover bare help, every subcommand's help aliases, and parser
  failures without contacting a daemon. New tests cover missing/corrupt metadata,
  missing token, auth/protocol failure, stale stopped endpoint, explicit/captured
  Doctor directory, typed Status freshness and remote success/failure replies.

Full suite, standalone compiled help checks, independent reviews and merge are
supervisor-owned follow-up gates. No live launchd/Caddy or real Host state was
accessed by this validation. No unrelated implementation or review was performed.
