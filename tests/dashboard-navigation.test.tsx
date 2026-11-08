import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { basic, local } from "./support/dashboard-site";
import type { RuntimeCommand } from "../src/daemon/protocol";
import * as daemon from "../web/server/daemon";
import { elements } from "./support/hook-harness";
import { PAGE_PATH_HEADER, pageReads } from "../web/lib/page-reads";

/** The sidebar's Projects: each Project's status is kept for a moment under rigd's pulse, so a page that shows one Project
 * does not observe every other. Every read of rigd is stood in for and counted; the clock is the test's. */

/** The page being rendered, as the proxy names it. */
let path = "/monitor";
mock.module("next/headers", () => ({
  headers: async () =>
    new Headers({
      ...local(),
      authorization: basic(),
      [PAGE_PATH_HEADER]: path,
    }),
  cookies: async () => ({ get: () => undefined, set() {} }),
}));
let health: () => unknown;
let queue: () => unknown;
let activity: () => unknown;
let status: (project: string) => unknown;
let asked: string[];
const real = { ...daemon };
/** Only while this file runs: test files share a process, and the others reach the real module. */
let standingIn = false;
const reply = async (value: () => unknown) => {
  const answer = value();
  if (answer instanceof Error) throw answer;
  return answer;
};
mock.module("../web/server/daemon", () => ({
  ...real,
  async daemon(root?: string) {
    if (!standingIn) return real.daemon(root);
    return {
      health: () => (asked.push("health"), reply(health)),
      command: (command: RuntimeCommand) => {
        asked.push(command.action);
        return reply(command.action === "queue" ? queue : activity);
      },
    };
  },
  async read(command: RuntimeCommand, signal?: AbortSignal) {
    if (!standingIn) return real.read(command as never, signal);
    if (command.action === "list")
      return {
        projects: [
          { name: "pantry", repoPath: "/p", targetCount: 2 },
          { name: "ledger", repoPath: "/l", targetCount: 1 },
          { name: "gone", repoPath: "/g", targetCount: 0, missing: true },
        ],
      };
    if (command.action === "status") {
      asked.push(`status:${command.project}`);
      return reply(() => status(command.project!));
    }
    if (command.action === "up") {
      asked.push("up");
      return { operationId: command.operationId, outcome: "started" };
    }
    throw new Error(`unexpected ${command.action}`);
  },
}));
const { ProjectTree } = await import("../web/components/shell/sidebar");
const { forgetNavigation, NAVIGATION_KEPT_MS } =
  await import("../web/server/navigation");
const { runCommand } = await import("../web/server/actions");

const target = (name: string, kind: string, state: string) => ({
  id: `${name}-id`,
  name,
  kind,
  state,
  components: [],
});
const reports: Record<string, unknown> = {
  pantry: {
    project: "pantry",
    targets: [
      target("working", "working", "running"),
      { ...target("stable", "stable", "healthy"), route: "pantry.test" },
    ],
  },
  ledger: {
    project: "ledger",
    targets: [target("working", "working", "failed")],
  },
};
let clock = 1_000_000;
beforeAll(() => {
  standingIn = true;
});
afterAll(() => {
  standingIn = false;
});
beforeEach(() => {
  forgetNavigation();
  asked = [];
  path = "/monitor";
  health = () => ({ instanceId: "i-1", pid: 42, running: true });
  queue = () => ({ waiting: 0, operations: [] });
  activity = () => ({ operations: [] });
  status = (project) => reports[project];
  clock += 1_000_000;
  spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
  (performance.now as unknown as { mockRestore(): void }).mockRestore();
});

/** What the sidebar offers: each link, with what it says of its Project's health or its Target's state. */
async function shown() {
  const tree = await ProjectTree();
  return elements(tree)
    .filter((each) => typeof each.props.href === "string")
    .map((each) => {
      const marks = elements(each.props.children);
      const dot = marks.find(
        (mark) => "health" in mark.props || "value" in mark.props,
      );
      const icon = marks.find((mark) => "favicon" in mark.props);
      return [
        each.props.href,
        dot?.props.health ?? dot?.props.value,
        ...(icon?.props.favicon ? ["favicon"] : []),
      ];
    });
}
const statusReads = () => asked.filter((each) => each.startsWith("status:"));
const SHOWN = [
  ["/projects/pantry", "green", "favicon"],
  ["/projects/pantry/targets/working", "running"],
  ["/projects/pantry/targets/stable", "healthy"],
  ["/projects/ledger", "red"],
  ["/projects/ledger/targets/working", "failed"],
  ["/projects/gone", "red"],
];

test("a second page under the same pulse observes no Project again, and offers the same links and states", async () => {
  expect(await shown()).toEqual(SHOWN);
  expect(statusReads().sort()).toEqual(["status:ledger", "status:pantry"]);
  asked = [];
  clock += NAVIGATION_KEPT_MS - 1;
  expect(await shown()).toEqual(SHOWN);
  expect(statusReads()).toEqual([]);
  // The pulse was still read, to know nothing changed.
  expect(asked.sort()).toEqual(["activity", "health", "queue"]);
});

test.each([
  [
    "an Operation recorded",
    () =>
      (activity = () => ({
        operations: [
          {
            id: "op",
            action: "down",
            outcome: "stopped",
            occurredAt: "2026-11-08T10:00:00.000Z",
          },
        ],
      })),
  ],
  [
    "a restarted rigd",
    () => (health = () => ({ instanceId: "i-2", pid: 43, running: true })),
  ],
  [
    "an Operation running",
    () =>
      (queue = () => ({
        waiting: 0,
        running: { operationId: "op", action: "up", project: "ledger" },
        operations: [
          {
            operationId: "op",
            action: "up",
            project: "ledger",
            phase: "running",
          },
        ],
      })),
  ],
  ["a pulse reading that failed", () => (activity = () => new Error("gone"))],
  ["the time kept running out", () => (clock += NAVIGATION_KEPT_MS)],
])("%s reads every Project afresh", async (_what, change) => {
  await shown();
  asked = [];
  change();
  status = (project) =>
    project === "ledger"
      ? {
          ...(reports.ledger as object),
          targets: [target("working", "working", "running")],
        }
      : reports[project];
  const after = await shown();
  expect(statusReads().sort()).toEqual(["status:ledger", "status:pantry"]);
  expect(after).toContainEqual(["/projects/ledger/targets/working", "running"]);
});

test("while an Operation runs nothing is kept, so the next page reads afresh too", async () => {
  queue = () => ({
    waiting: 1,
    running: { operationId: "op", action: "up" },
    operations: [{ operationId: "op", action: "up", phase: "running" }],
  });
  await shown();
  queue = () => ({ waiting: 0, operations: [] });
  asked = [];
  await shown();
  expect(statusReads().sort()).toEqual(["status:ledger", "status:pantry"]);
});

test("a Project's failed status is never kept, and each Project shows its own status, never another's", async () => {
  status = (project) =>
    project === "ledger"
      ? Object.assign(new Error("rigd could not observe ledger."), {
          code: "STATUS_FAILED",
        })
      : reports[project];
  const first = await shown();
  expect(first).toContainEqual(["/projects/ledger", "red"]);
  expect(
    first.filter(([href]) => String(href).startsWith("/projects/ledger/")),
  ).toEqual([]);
  asked = [];
  status = (project) => reports[project];
  expect(await shown()).toEqual(SHOWN);
  // Only the failed one is read again.
  expect(statusReads()).toEqual(["status:ledger"]);
});

test("a command from the page drops what is kept, even one that ended while a read was in flight", async () => {
  await shown();
  asked = [];
  const answered = await runCommand({ action: "up", project: "ledger" });
  expect(answered.ok).toBe(true);
  await shown();
  expect(statusReads().sort()).toEqual(["status:ledger", "status:pantry"]);
  // A command that ends while the sidebar is still reading: what that read saw is not kept.
  asked = [];
  let open = () => {};
  const held = new Promise<void>((resolve) => (open = resolve));
  status = (project) => held.then(() => reports[project]);
  const reading = shown();
  await new Promise((resolve) => setImmediate(resolve));
  forgetNavigation();
  open();
  await reading;
  status = (project) => reports[project];
  asked = [];
  await shown();
  expect(statusReads().sort()).toEqual(["status:ledger", "status:pantry"]);
});

test("a Project the page reads itself is shown as the page read it, a failure or a changed Target list included", async () => {
  expect(await shown()).toEqual(SHOWN);
  // pantry's own page: its read fails, while ledger, which the page does not read, is still the kept one.
  path = "/projects/pantry/logs";
  asked = [];
  status = (project) =>
    project === "pantry"
      ? Object.assign(new Error("The connection to rigd closed."), {
          code: "DAEMON_INTERRUPTED",
        })
      : reports[project];
  const failed = await shown();
  expect(statusReads()).toEqual(["status:pantry"]);
  expect(failed).toContainEqual(["/projects/pantry", "red"]);
  expect(
    failed.filter(([href]) => String(href).startsWith("/projects/pantry/")),
  ).toEqual([]);
  expect(failed).toContainEqual(["/projects/ledger/targets/working", "failed"]);
  // A config change took the stable Target away: its own Target page lists what the page read.
  path = "/projects/pantry/targets/working";
  status = (project) =>
    project === "pantry"
      ? {
          project: "pantry",
          targets: [target("working", "working", "running")],
        }
      : reports[project];
  const changed = await shown();
  expect(
    changed.filter(([href]) => String(href).startsWith("/projects/pantry")),
  ).toEqual([
    ["/projects/pantry", "green"],
    ["/projects/pantry/targets/working", "running"],
  ]);
  // The Overview reads every Project, so the sidebar shows every one as read now.
  path = "/";
  asked = [];
  await shown();
  expect(statusReads().sort()).toEqual(["status:ledger", "status:pantry"]);
});

test("a record dated before the newest, as after the clock went back, still reads every Project afresh", async () => {
  const record = (id: string, occurredAt: string) => ({
    id,
    action: "up",
    outcome: "started",
    occurredAt,
  });
  activity = () => ({
    operations: [record("a", "2026-11-08T10:00:00.000Z")],
    total: 1,
  });
  await shown();
  asked = [];
  // A crash recorded with an earlier time: neither the count of what is returned nor the newest time moves.
  activity = () => ({
    operations: [
      record("crash", "2026-11-08T09:00:00.000Z"),
      record("a", "2026-11-08T10:00:00.000Z"),
    ].slice(-1),
    total: 2,
  });
  await shown();
  expect(statusReads().sort()).toEqual(["status:ledger", "status:pantry"]);
  // Within the newest returned, only the ids move.
  asked = [];
  activity = () => ({
    operations: [
      record("crash-2", "2026-11-08T09:30:00.000Z"),
      record("a", "2026-11-08T10:00:00.000Z"),
    ],
  });
  await shown();
  asked = [];
  activity = () => ({
    operations: [
      record("crash-3", "2026-11-08T09:30:00.000Z"),
      record("a", "2026-11-08T10:00:00.000Z"),
    ],
  });
  await shown();
  expect(statusReads().sort()).toEqual(["status:ledger", "status:pantry"]);
});

test("the pages that read Projects themselves are known by their path", () => {
  expect(pageReads("/")).toBe("all");
  expect(pageReads("/proxy")).toBe("all");
  expect(pageReads(null)).toBe("all");
  expect(pageReads("/projects/%E0%A4%A")).toBe("all");
  expect(pageReads("/projects/pantry")).toEqual(["pantry"]);
  expect(pageReads("/projects/pantry/targets/working/logs")).toEqual([
    "pantry",
  ]);
  expect(pageReads("/projects/my%20app/jobs")).toEqual(["my app"]);
  expect(pageReads("/projects/new")).toEqual([]);
  expect(pageReads("/monitor")).toEqual([]);
  expect(pageReads("/activity")).toEqual([]);
});
