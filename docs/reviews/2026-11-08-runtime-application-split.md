# Runtime application split

How `createRuntime` is put together since #432 split `src/runtime/application.ts`, the rules that hold across its owners, and the evidence that the split changed no behaviour. `application.ts` is now the one composition point: it builds each owner below with only what that owner uses, and answers `RigRuntime` from them.

## Owners

| Module                                 | Owns                                                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/runtime/operation-coordinator.ts` | Operation admission and leases (`Admission`, `Reselect`, `OPERATION_CONTENDED`), the Operations listed for status and `queue`, `--kill` requests, Preview and port claims, the drain, the gate |
| `src/runtime/command-execution.ts`     | Dispatching a command to its family, Project and Target selection, admission on a Project's or a Target's scopes, recording a failure                                                          |
| `src/runtime/operation-outcome.ts`     | What a command's Activity entry, deployment history and diagnostic say, gathered as it runs, and its reply                                                                                     |
| `src/runtime/host-commands.ts`         | Commands before a Project is selected: uninstall preparation, `rig proxy`, DNS, `list`, Host-wide Activity and Monitor, `initialization-info`, Host-only doctor                                |
| `src/runtime/project-reads.ts`         | Reads of one Project: status, deployment context, Monitor, Activity, deployments, backups, logs                                                                                                |
| `src/runtime/registration-commands.ts` | `init`, `forget`, `rename`, `repoint`                                                                                                                                                          |
| `src/runtime/target-commands.ts`       | `up`, `down`, `restart`, Preview destroy, `run`, backup restore                                                                                                                                |
| `src/runtime/deploy-command.ts`        | `deploy`, and the Preview slot it claims at the limit                                                                                                                                          |
| `src/runtime/previews.ts`              | The Preview limit's choice (`previewsToReplace`) and Preview destruction                                                                                                                       |
| `src/runtime/background-operations.ts` | rigd's own Operations on a Target: health restarts, scheduled runs, job settling and deadlines, job runs of a role turned off, held checkouts                                                  |
| `src/runtime/supervision-passes.ts`    | The reconcile and supervise passes, and what a Host restart left unrecorded (`HostRestartRecords`)                                                                                             |
| `src/runtime/orphan-routes.ts`         | Withdrawing route blocks no recorded Target owns, and the ROUTE_CONFLICT wording for them                                                                                                      |
| `src/runtime/revisions.ts` (added to)  | Giving back held checkouts                                                                                                                                                                     |
| `src/runtime/projects.ts` (added to)   | `checkoutConfig`, the Project's rig.yaml read once per action                                                                                                                                  |

There is still one lock registry, one list of Operations and one drain, all in the coordinator. Every other owner reaches them through its interface.

## The gate

Nothing starts until rigd has reconciled the Host session. The gate starts closed (unless the dependencies say `reconcileGate: "open"`, as a test that never reconciles does). It opens once a first pass has read the state, and so has recorded any Host restart or held its pending stops. It closes again when a first pass cannot read it. While it is closed every pass is a first pass, and nothing starts a Service: no supervision start, no health restart or start, and up, restart, deploy, run and restore are refused `HOST_STATE_PENDING`; down, stops and destroy still run. So no run is ever journalled before a Host restart's record, whose `seq` therefore comes before every start made after the restart, however early a command reaches rigd.

The coordinator holds the gate, since admission checks it; the passes open and close it. `tests/health-restart-integration.test.ts` covers it: a command that reaches a new rigd before its first pass, and a first pass that cannot read the state.

## What the split keeps in order

- Each attempt of an Operation gets its own admission, route guard and port claims. They end in that order: the guard is joined, then the lease released, then the claims. Then the `--kill` request ends, and the Operation leaves the list.
- `draining` is checked right after a lease is granted, and the gate right after that, with no await between.
- A command plans from rig.yaml as it is once admitted. A changed revision, or a Project renamed, repointed or forgotten while it waited, makes it select again.
- A Preview's count and claim happen with nothing awaited between them.
- What the Host restart left unrecorded is recorded under the Target's lease before anything acts on the Target.
- `operation-outcome.ts` reads what each family set as it set it. A failure at any point is recorded with the project, Target, note and deploy source known then.

## Equivalence when it was split

The split changed no behaviour. Besides the existing tests, a harness ran the old `createRuntime` (from `origin/main` at `8c876788`) and the new one over the same seeded scenarios with fake dependencies. Every dependency call was deferred to a seeded scheduler that hands over one result per turn of the event loop. The scenarios included:

- concurrent commands contending for the same Targets, Projects, zones and the Host;
- drains and uninstall preparations racing them, and `--kill`;
- config edits that send a waiting command to select again, up to `OPERATION_CONTENDED`;
- deploys at the Preview limit;
- rigd's own Operations;
- a daemon restart, with and without a Host restart;
- injected failures of any dependency call.

The harness recorded and compared every call with its arguments, every value the clock and ids gave, every state write, every reply and failure, the `queue` report and `targetBusy` of every Target after each turn, and the final state. The PR gives the counts and the deliberate mutations it caught.

The new code awaits the same things in the same order within each Operation. A command now passes through one or two more async frames, on success as well as on failure. So when two commands' dependencies answer in the same turn, the new code can finish them in a different order than the old code did. This affects which reply is ready first, and when a refusal's diagnostic is issued relative to the other command's calls. For example, a `logs` read and an `initialization-info` read whose answers arrive together can reply in the opposite order. Rig promises ordering within an Operation's scope (its leases, Activity and state writes), not a total order of replies across independent commands, and those scoped orders are unchanged. The harness compares each turn's lines as a set as well as in order, and reports both.
