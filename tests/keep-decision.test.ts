import { describe, expect, test } from "bun:test";
import type { ManagedComponent, TargetPlan } from "../src/config/types";
import type { ServiceRun, TargetRecord } from "../src/domain/runtime";
import { serviceDefinition } from "../src/domain/service-definition";
import {
  decideKept,
  servicesToObserve,
  type KeepFacts,
  type KeepInput,
  type RestartReason,
} from "../src/runtime/keep-decision";

/* The pure keep decision of ADR 0016 over Melody's shape: db and search, api on both, web on api. */

const OLD = "/rig/targets/p/t/revisions/old";
const NEW = "/rig/targets/p/t/revisions/new";

function service(
  name: string,
  at: string,
  dependsOn: string[] = [],
  extra: Partial<ManagedComponent> = {},
): ManagedComponent {
  return {
    name,
    kind: "managed",
    command: `run ${name} from ${at}`,
    env: { PATH: "/usr/bin" },
    dependsOn,
    readyTimeout: 30,
    restart: "always",
    ...extra,
  };
}
function plan(
  at: string,
  changes: Record<string, Partial<ManagedComponent>> = {},
  only?: string[],
): TargetPlan {
  const all = [
    service("db", at, [], changes.db),
    service("search", at, [], changes.search),
    service("api", at, ["db", "search"], changes.api),
    service("web", at, ["api"], changes.web),
    ...(changes.worker ? [service("worker", at, ["db"], changes.worker)] : []),
  ];
  return {
    project: "melody",
    target: "stable",
    workspacePath: at,
    dataRoot: "/rig/targets/p/t/data",
    deploymentName: "stable",
    branchSlug: "stable",
    subdomain: "stable",
    providers: { processSupervisor: "rigd" },
    components: only ? all.filter((c) => only.includes(c.name)) : all,
    preparedComponents: [],
  };
}
/** The previous record: every Service running the process it recorded, started from OLD at c1. */
function previous(
  overrides: Partial<Record<string, Partial<ServiceRun>>> = {},
  record: Partial<TargetRecord> = {},
): KeepInput["previous"] {
  const before = plan(OLD);
  return {
    plan: before,
    desired: "running",
    services: Object.fromEntries(
      before.components.map((component) => [
        component.name,
        {
          deployment: OLD,
          intent: "running",
          incarnation: `inc-${component.name}`,
          attempts: [],
          source: {
            checkout: OLD,
            commit: "c1",
            definition: serviceDefinition(
              before,
              component as ManagedComponent,
            ),
            environment: `env-${component.name}`,
          },
          ...overrides[component.name],
        } satisfies ServiceRun,
      ]),
    ),
    ...record,
  };
}
/** What the deploy observes when nothing changed: each recorded process running, healthy, the same environment, no
 * watched file changed. */
function facts(
  changes: Partial<Record<string, Partial<KeepFacts>>> = {},
): Map<string, KeepFacts> {
  return new Map(
    ["db", "search", "api", "web", "worker"].map((name) => [
      name,
      {
        process: { state: "running", incarnation: `inc-${name}` },
        unhealthy: false,
        environment: `env-${name}`,
        changed: false,
        ...changes[name],
      },
    ]),
  );
}
const decide = (input: Partial<KeepInput> = {}) =>
  decideKept({
    previous: previous(),
    candidate: { plan: plan(NEW) },
    keep: true,
    facts: facts(),
    ...input,
  });

describe("decideKept", () => {
  test("a deploy that changed nothing a Service uses keeps every Service running, though the checkout moved", () => {
    expect(decide()).toEqual({
      kept: ["db", "search", "api", "web"],
      restarted: [],
      removed: [],
    });
  });

  test("a web-only change restarts web alone; a script change restarts db and every dependent, transitively", () => {
    expect(decide({ facts: facts({ web: { changed: true } }) })).toEqual({
      kept: ["db", "search", "api"],
      restarted: [{ service: "web", reason: "files" }],
      removed: [],
    });
    expect(decide({ facts: facts({ db: { changed: true } }) })).toEqual({
      kept: ["search"],
      restarted: [
        { service: "db", reason: "files" },
        { service: "api", reason: "dependency", dependency: "db" },
        { service: "web", reason: "dependency", dependency: "api" },
      ],
      removed: [],
    });
  });

  test("a new Service starts, one the new plan dropped is stopped, and --force or --no-up keeps nothing", () => {
    expect(
      decide({
        candidate: {
          plan: plan(NEW, { worker: {} }, ["db", "search", "api", "worker"]),
        },
      }),
    ).toEqual({
      kept: ["db", "search", "api"],
      restarted: [{ service: "worker", reason: "new" }],
      removed: ["web"],
    });
    expect(decide({ keep: false }).kept).toEqual([]);
    expect(decide({ keep: false }).restarted.map((r) => r.reason)).toEqual([
      "requested",
      "requested",
      "requested",
      "requested",
    ]);
  });

  test("a run that records nothing to compare, an incomplete previous deploy, or a stopped Target restarts", () => {
    const unrecorded = previous();
    delete unrecorded.services!.search!.source;
    expect(decide({ previous: unrecorded }).restarted).toContainEqual({
      service: "search",
      reason: "unrecorded",
    });
    expect(
      decide({ previous: previous({}, { deploymentIncomplete: true }) }).kept,
    ).toEqual([]);
    expect(
      decide({ previous: previous({}, { desired: "stopped" }) }).restarted[0],
    ).toEqual({ service: "db", reason: "not-running" });
    expect(
      decide({ previous: previous({ search: { intent: "stopped" } }) })
        .restarted,
    ).toEqual([
      { service: "search", reason: "not-running" },
      { service: "api", reason: "dependency", dependency: "search" },
      { service: "web", reason: "dependency", dependency: "api" },
    ]);
    // A run of another Deployment describes nothing.
    expect(
      decide({ previous: previous({ web: { deployment: "/elsewhere" } }) })
        .restarted,
    ).toEqual([{ service: "web", reason: "unrecorded" }]);
  });

  test("a changed definition restarts the Service; a changed watch alone does not", () => {
    expect(
      decide({
        candidate: { plan: plan(NEW, { search: { stopTimeout: 60 } }) },
      }).restarted[0],
    ).toEqual({ service: "search", reason: "definition" });
    expect(
      decide({
        candidate: {
          plan: plan(NEW, { db: { watch: ["scripts/rig-postgres.sh"] } }),
        },
      }).kept,
    ).toEqual(["db", "search", "api", "web"]);
    // The Project's shared build is part of every definition.
    const built = plan(NEW);
    built.builds = [{ id: "shared", command: "pnpm install", timeout: 600 }];
    expect(decide({ candidate: { plan: built } }).kept).toEqual([]);
  });

  test("a process that is not the recorded one, or cannot be observed, restarts", () => {
    const cases: [Partial<KeepFacts>, RestartReason][] = [
      [{ process: { state: "stopped" } }, "not-running"],
      [{ process: { state: "running", incarnation: "other" } }, "not-running"],
      [{ process: { state: "running" } }, "not-running"],
      [{ process: { state: "unknown" } }, "unobserved"],
      [{ process: undefined }, "unobserved"],
    ];
    for (const [observed, reason] of cases)
      expect(decide({ facts: facts({ web: observed }) }).restarted).toEqual([
        { service: "web", reason },
      ]);
  });

  test("an unhealthy Service, or one waiting for a health restart, restarts", () => {
    expect(
      decide({ facts: facts({ web: { unhealthy: true } }) }).restarted,
    ).toEqual([{ service: "web", reason: "unhealthy" }]);
    expect(
      decide({
        previous: previous({
          web: { healthStretch: { since: 1, restarts: [2], pendingStart: 3 } },
        }),
      }).restarted,
    ).toEqual([{ service: "web", reason: "unhealthy" }]);
    // An unhealthy stretch that is over keeps it.
    expect(
      decide({
        previous: previous({
          web: { healthStretch: { since: 1, restarts: [2] } },
        }),
      }).kept,
    ).toContain("web");
  });

  test("a changed or unknown environment, or files that cannot be compared, restart", () => {
    expect(
      decide({ facts: facts({ search: { environment: "rotated" } }) })
        .restarted[0],
    ).toEqual({ service: "search", reason: "environment" });
    expect(
      decide({ facts: facts({ search: { environment: undefined } }) })
        .restarted[0],
    ).toEqual({ service: "search", reason: "environment" });
    const undigested = previous();
    delete undigested.services!.search!.source!.environment;
    expect(decide({ previous: undigested }).restarted[0]).toEqual({
      service: "search",
      reason: "environment",
    });
    expect(
      decide({ facts: facts({ search: { changed: undefined } }) }).restarted[0],
    ).toEqual({ service: "search", reason: "files" });
  });
});

test("servicesToObserve names only the Services the records leave open", () => {
  const unrecorded = previous();
  delete unrecorded.services!.search!.source;
  expect(
    servicesToObserve({
      previous: unrecorded,
      candidate: { plan: plan(NEW, { db: { command: "postgres" } }) },
      keep: true,
    }),
  ).toEqual(["api", "web"]);
  expect(
    servicesToObserve({
      previous: previous(),
      candidate: { plan: plan(NEW) },
      keep: false,
    }),
  ).toEqual([]);
});
