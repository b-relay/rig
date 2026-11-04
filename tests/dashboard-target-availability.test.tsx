import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { basic, local } from "./support/dashboard-site";
import { elements, mountWithoutDom, textOf } from "./support/hook-harness";
import type { RuntimeCommand } from "../src/daemon/protocol";
import * as daemon from "../web/server/daemon";
import { TargetActions } from "../web/components/target-actions";
import { SettingsForms } from "../web/components/settings-forms";
import { Confirm } from "../web/components/confirm";
import { ProjectMonitor } from "../web/components/project-monitor";
import { projectMonitor } from "../web/server/monitor";
import { JobCards } from "../web/components/job-cards";
import SettingsPage from "../web/app/projects/[name]/(sections)/settings/page";
import DeploymentsPage from "../web/app/projects/[name]/(sections)/deployments/page";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import {
  completedNotice,
  lastActionText,
  projectWork,
} from "../web/lib/target-work";
import type { ActivityResult, TargetReport } from "../web/lib/types";

/** What the dashboard offers of a Target and a registration, and what it does once an action ends. Each component is driven
 * as an operator would, over the real Server Action and admission, with rigd stood in for. */

mock.module("next/headers", () => ({
  headers: async () => new Headers({ ...local(), authorization: basic() }),
  cookies: async () => ({ get: () => undefined, set() {} }),
}));
const real = { ...daemon };
let answer: ((command: RuntimeCommand) => unknown) | undefined;
mock.module("../web/server/daemon", () => ({
  ...real,
  async read(command: RuntimeCommand) {
    return answer ? answer(command) : real.read(command as never);
  },
}));

const loads: string[] = [];
const previousWindow = (globalThis as { window?: unknown }).window;
beforeAll(() => {
  (globalThis as { window?: unknown }).window = {
    location: { host: "rig.test", assign: (href: string) => loads.push(href) },
  };
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = previousWindow;
  answer = undefined;
});
const replying =
  (outcome: string) =>
  (command: RuntimeCommand): unknown => ({
    operationId: command.operationId,
    action: command.action,
    outcome,
  });
const refusing = (code: string, message: string, hint: string) => () => {
  throw Object.assign(new Error(message), { code, hint });
};
/** Gives the event loop turns until the action has ended, as `ended` says; no clock is waited on. */
async function until(ended: () => boolean) {
  for (let turn = 0; turn < 10_000 && !ended(); turn++)
    await new Promise((resolve) => setImmediate(resolve));
  expect(ended()).toBe(true);
}

const OFF = {
  code: "TARGET_OFF",
  message: "The stable Target is off in rig.yaml.",
  hint: "Change `stable: false` to `stable: true` under targets in rig.yaml.",
};
const stable = (fields: Partial<TargetReport> = {}): TargetReport => ({
  id: "t-1",
  name: "stable",
  kind: "stable",
  state: "healthy",
  branch: "main",
  components: [],
  ...fields,
});
const preview = (fields: Partial<TargetReport> = {}): TargetReport =>
  stable({ name: "feature", kind: "preview", branch: "feature", ...fields });

type Props = Parameters<typeof TargetActions>[0];
function actions(props: Partial<Props> & Pick<Props, "target">) {
  const mounted = mountWithoutDom(TargetActions);
  mounted.render({
    project: "demo",
    layout: "buttons",
    stacked: true,
    ...props,
  });
  /** The control a verb's word labels: a header button or a menu item. */
  const controls = (word: string) =>
    elements(mounted.tree).filter(
      (each) =>
        (typeof each.props.onClick === "function" ||
          typeof each.props.onSelect === "function") &&
        textOf(each).includes(word),
    );
  return { mounted, controls };
}

test("an off Target's Deploy latest, Start and Restart are disabled and say why; Stop stays, in the menu and as buttons", () => {
  const { controls } = actions({
    target: stable({
      refusals: { up: OFF, restart: OFF, deploy: OFF },
    }),
  });
  for (const word of ["Deploy latest", "Restart", "Start"])
    for (const control of controls(word)) {
      expect(control.props.disabled).toBe(true);
      expect(String(control.props.title)).toContain(OFF.hint);
    }
  expect(controls("Deploy latest").length).toBeGreaterThan(0);
  // A disabled menu item takes no hover, so it says why in its own words.
  expect(
    textOf(controls("Deploy latest").find((each) => each.props.onSelect)),
  ).toContain(OFF.message);
  expect(controls("Stop").length).toBeGreaterThan(0);
  for (const control of controls("Stop"))
    expect(control.props.disabled ?? false).toBe(false);
});

test("turning the role back on restores the actions on the next refresh", () => {
  const { mounted, controls } = actions({
    target: stable({ refusals: { deploy: OFF } }),
  });
  expect(controls("Deploy latest")[0]?.props.disabled).toBe(true);
  mounted.render({
    project: "demo",
    layout: "buttons",
    stacked: true,
    target: stable(),
  });
  for (const control of controls("Deploy latest"))
    expect(control.props.disabled ?? false).toBe(false);
});

test("an off Preview can still be destroyed", () => {
  const { controls } = actions({
    target: preview({ refusals: { deploy: OFF } }),
  });
  expect(controls("Destroy")[0]?.props.disabled).toBe(false);
});

test("a card's Start is disabled for a stopped Target that is off, and says why", () => {
  const { controls } = actions({
    layout: "card",
    stacked: false,
    target: stable({ state: "stopped", refusals: { up: OFF } }),
  });
  const start = controls("Start").find((each) => each.props.onClick);
  expect(start?.props.disabled).toBe(true);
  expect(String(start?.props.title)).toContain(OFF.message);
});

const queued = (fields: Record<string, unknown> = {}) =>
  ({
    operationId: "op-1",
    action: "up",
    project: "demo",
    target: "stable",
    phase: "starting",
    startedAt: "2026-10-10T10:00:00.000Z",
    ...fields,
  }) as never;
const record = (
  fields: Partial<ActivityResult["operations"][number]>,
): ActivityResult["operations"][number] => ({
  id: "op-1",
  action: "restart",
  outcome: "failed",
  occurredAt: "2026-10-10T10:00:00.000Z",
  project: "demo",
  target: "stable",
  ...fields,
});

test("after a reload, the work rigd is doing to a Target, whoever asked, keeps its controls from sending it again", () => {
  const work = projectWork(
    "demo",
    { operations: [queued()] },
    { operations: [] },
  );
  const { controls, mounted } = actions({
    target: stable({ state: "stopped" }),
    work: work.stable!,
  });
  expect(controls("Start")[0]?.props.disabled).toBe(true);
  expect(controls("Deploy latest")[0]?.props.disabled).toBe(true);
  expect(
    elements(mounted.tree).some(
      (each) => each.props["aria-label"] === "up is running (starting)",
    ),
  ).toBe(true);
  // Logs stay reachable behind the menu while it runs.
  expect(
    elements(mounted.tree).find(
      (each) => each.props["aria-label"] === "Actions for stable",
    )?.props.disabled,
  ).toBe(false);

  // Once rigd is done, the actions come back with the next refresh.
  mounted.render({
    project: "demo",
    layout: "buttons",
    stacked: true,
    target: stable({ state: "stopped" }),
  });
  expect(controls("Start")[0]?.props.disabled).toBe(false);
});

test("only what rigd runs for this Project's Target, on someone's asking, is its work", () => {
  const work = projectWork(
    "demo",
    {
      operations: [
        queued({ project: "other", target: "stable" }),
        queued({ action: "supervise", target: "working" }),
        queued({ action: "reconcile", target: "feature" }),
        queued({ action: "deploy", target: "feature", phase: "building" }),
      ],
    },
    undefined,
  );
  expect(work.stable).toBeUndefined();
  expect(work.working).toBeUndefined();
  expect(work.feature?.running).toEqual({
    operationId: "op-1",
    action: "deploy",
    phase: "building",
  });
});

/** The card's mark and its dialog, as they would render from the props the card gave them. */
function markShown(mark: ReturnType<typeof elements>[number]) {
  const shown = mountWithoutDom(mark.type as (props: never) => ReactNode);
  shown.render(mark.props as never);
  return shown;
}
test("a reload does not lose how the last action ended: a failed shared build stays said until a later action ends", () => {
  const failed = record({ message: "BUILD_FAILED", id: "op-fail" });
  const work = projectWork("demo", undefined, {
    operations: [
      record({ id: "op-old", action: "up", outcome: "started" }),
      failed,
      // None of these is the outcome of a control's action.
      record({
        id: "op-crash",
        action: "crash",
        occurredAt: "2026-10-10T11:00:00.000Z",
      }),
      record({
        id: "op-job",
        action: "run",
        component: { kind: "job", name: "nightly" },
        occurredAt: "2026-10-10T11:00:00.000Z",
      }),
    ],
  });
  expect(work.stable?.last).toEqual(failed);
  expect(lastActionText(failed)).toBe(
    "Activity's last action: restart failed: BUILD_FAILED",
  );
  const { mounted } = actions({
    target: stable({ state: "stopped" }),
    work: work.stable!,
  });
  expect(textOf(mounted.tree)).toContain(
    "Activity's last action: restart failed: BUILD_FAILED",
  );

  const ok = projectWork("demo", undefined, {
    operations: [
      failed,
      record({
        id: "op-new",
        action: "up",
        outcome: "started",
        occurredAt: "2026-10-10T12:00:00.000Z",
      }),
    ],
  });
  expect(ok.stable?.last?.id).toBe("op-new");
  expect(lastActionText(ok.stable!.last!)).toBe(
    "Activity's last action: started",
  );
});

test("a card marks a failure a reload would have lost, and says nothing of a success", () => {
  const failing = actions({
    layout: "card",
    stacked: false,
    target: stable({ state: "stopped" }),
    work: { last: record({ message: "BUILD_FAILED" }) },
  });
  const mark = elements(failing.mounted.tree).find(
    (each) => (each.type as { name?: string }).name === "OutcomeMark",
  );
  expect(mark?.props.last).toMatchObject({ message: "BUILD_FAILED" });
  const fine = actions({
    layout: "card",
    stacked: false,
    target: stable(),
    work: { last: record({ outcome: "started" }) },
  });
  // A success alone is no news on a card: the mark renders nothing.
  expect(
    markShown(
      elements(fine.mounted.tree).find(
        (each) => (each.type as { name?: string }).name === "OutcomeMark",
      )!,
    ).tree,
  ).toBeNull();
});

/** Confirms Destroy in a Target's actions, as the dialog's button does. */
async function destroy(target: TargetReport) {
  const { mounted, controls } = actions({ target });
  mounted.act(() =>
    (
      controls("Destroy").find((each) => each.props.onSelect)!.props
        .onSelect as () => void
    )(),
  );
  const confirm = elements(mounted.tree).find(
    (each) =>
      typeof each.props.onClick === "function" &&
      each.props.variant === "destructive",
  )!;
  mounted.act(() => (confirm.props.onClick as () => void)());
  await until(() => loads.length > 0 || mounted.refreshes.count > 0);
  mounted.render();
  return mounted;
}

test("a destroyed Preview leaves for its Project's page, freshly loaded, naming the Operation; its own page never redraws", async () => {
  loads.length = 0;
  answer = replying("stopped");
  const mounted = await destroy(preview());
  expect(loads).toHaveLength(1);
  expect(loads[0]).toStartWith("/projects/demo?operation=");
  expect(mounted.refreshes.count).toBe(0);
});

test("a refused destroy stays on the Preview, with the real failure, and refreshes", async () => {
  loads.length = 0;
  answer = refusing(
    "DESTROY_OWNERSHIP",
    "This Preview's directory is not Rig's.",
    "Check it.",
  );
  const mounted = await destroy(preview());
  expect(loads).toEqual([]);
  expect(mounted.refreshes.count).toBe(1);
  const failure = elements(mounted.tree).find(
    (each) => (each.type as { name?: string }).name === "Failure",
  );
  expect(failure?.props.failure).toMatchObject({
    code: "DESTROY_OWNERSHIP",
  });
});

function settings(props: Partial<Parameters<typeof SettingsForms>[0]> = {}) {
  const mounted = mountWithoutDom(SettingsForms);
  mounted.render({ project: "demo", repoPath: "/repo", ...props });
  const button = (word: string) =>
    elements(mounted.tree).find(
      (each) => each.props.variant !== undefined && textOf(each) === word,
    );
  return { mounted, button };
}
const ACTIVE = {
  code: "PROJECT_ACTIVE",
  message:
    "Project registration can only change while every Target is stopped.",
  hint: "Stop stable, feature and retry.",
};

test("while a Target stands in the way, Rename, Repoint and Forget are disabled and name it", () => {
  const { mounted, button } = settings({
    refusals: { rename: ACTIVE, repoint: ACTIVE, forget: ACTIVE },
  });
  for (const word of ["Rename", "Repoint", "Forget Project"])
    expect(button(word)?.props.disabled).toBe(true);
  const said = elements(mounted.tree).filter(
    (each) => (each.type as { name?: string }).name === "Refused",
  );
  expect(said.map((each) => each.props.refusal)).toEqual([
    ACTIVE,
    ACTIVE,
    ACTIVE,
  ]);
});

test("once everything is stopped Rename and Repoint open, and Forget still waits for its Preview", () => {
  const { button } = settings({
    refusals: {
      forget: {
        code: "PROJECT_TARGETS",
        message: "Project 'demo' still has 1 Preview: feature.",
        hint: "Destroy it.",
      },
    },
  });
  expect(button("Rename")?.props.disabled).toBe(false);
  expect(button("Repoint")?.props.disabled).toBe(false);
  expect(button("Forget Project")?.props.disabled).toBe(true);
});

test("with nothing refused, every registration control is enabled and rigd decides", () => {
  const { button } = settings();
  for (const word of ["Rename", "Repoint", "Forget Project"])
    expect(button(word)?.props.disabled).toBe(false);
});

async function forget() {
  const { mounted } = settings();
  const confirm = elements(mounted.tree).find((each) => each.type === Confirm)!;
  mounted.act(() => (confirm.props.onConfirm as () => void)());
  await until(() => loads.length > 0 || mounted.refreshes.count > 0);
  mounted.render();
  return mounted;
}

test("a forgotten Project leaves by a full load, so no cached overview, sidebar or Project page can revive it", async () => {
  loads.length = 0;
  answer = replying("forgotten");
  const mounted = await forget();
  // router.push would come back to the five-minute router cache.
  expect(mounted.pushes).toEqual([]);
  expect(loads).toHaveLength(1);
  expect(loads[0]).toStartWith("/?operation=");
});

test("a refused forget stays, says why, and refreshes what the page offers", async () => {
  loads.length = 0;
  answer = refusing("PROJECT_ACTIVE", ACTIVE.message, ACTIVE.hint);
  const mounted = await forget();
  expect(loads).toEqual([]);
  expect(mounted.refreshes.count).toBe(1);
  const failure = elements(mounted.tree).find(
    (each) =>
      (each.type as { name?: string }).name === "Failure" &&
      each.props.failure !== undefined,
  );
  expect(failure?.props.failure).toMatchObject({ code: "PROJECT_ACTIVE" });
});

test("the page an action lands on says only what Activity recorded of that Operation", () => {
  const destroyed = record({
    id: "op-d",
    action: "destroy",
    outcome: "stopped",
    target: "feature",
  });
  expect(completedNotice([destroyed], "op-d", "demo")).toEqual({
    operationId: "op-d",
    text: "Preview feature was destroyed.",
  });
  const forgotten = record({
    id: "op-f",
    action: "forget",
    outcome: "forgotten",
    target: undefined,
  } as never);
  expect(completedNotice([forgotten], "op-f", undefined)?.text).toContain(
    "Project demo was forgotten",
  );
  // Another Project's Operation, a failed one, one of no such action, and an unknown one claim nothing.
  expect(completedNotice([destroyed], "op-d", "other")).toBeUndefined();
  expect(
    completedNotice([{ ...destroyed, outcome: "failed" }], "op-d", "demo"),
  ).toBeUndefined();
  expect(
    completedNotice([{ ...destroyed, action: "up" }], "op-d", "demo"),
  ).toBeUndefined();
  expect(completedNotice([destroyed], "nope", "demo")).toBeUndefined();
});

/** A recreated Preview on Monitor: the earlier one sampled last, so only the ids status reports can tell them apart. */
function monitorReads(command: RuntimeCommand): unknown {
  const stats = { low: 1, high: 1, average: 1, median: 1, p95: 1 };
  const reported = (series: Record<string, unknown>, at: number) => ({
    series: {
      projectId: "p",
      project: "demo",
      target: "feature",
      targetKind: "preview",
      ...series,
    },
    summary: { cpu: stats, memory: stats },
    now: { cpuPercent: at, memoryBytes: at },
    points: [{ at: 1000, cpu: stats, memory: stats }],
  });
  if (command.action === "status")
    return {
      project: "demo",
      projectId: "p",
      targets: [
        preview({
          id: "new",
          components: [{ name: "api", kind: "managed", state: "running" }],
        }),
      ],
    };
  return {
    since: 1000,
    from: 1000,
    to: 1045,
    step: 15,
    sampledEvery: 1,
    series: [
      reported({ scope: "target", targetId: "old" }, 9),
      reported({ scope: "target", targetId: "new" }, 2),
      reported(
        {
          scope: "component",
          targetId: "old",
          componentKind: "service",
          component: "web",
        },
        9,
      ),
      reported(
        {
          scope: "component",
          targetId: "new",
          componentKind: "service",
          component: "api",
        },
        2,
      ),
    ],
  };
}
async function monitorPage(target: string) {
  answer = monitorReads;
  const view = await projectMonitor("demo", "1h", target);
  answer = undefined;
  if (!view.usage.ok) throw new Error("the monitor read failed");
  return {
    view,
    html: renderToStaticMarkup(
      <ProjectMonitor
        project="demo"
        initial={view.usage.value}
        range="1h"
        target={view.target}
        {...(view.targetId ? { targetId: view.targetId } : {})}
        inventory={view.inventory}
        operations={[]}
        now={0}
        doctor={null}
        activity={null}
      />,
    ),
  };
}
const cardsIn = (html: string, name: string) =>
  [
    ...html.matchAll(
      /<span class="truncate font-mono">([^<]*)<\/span>(<span[^>]*>earlier<\/span>)?/g,
    ),
  ]
    .filter((match) => match[1] === name)
    .map((match) => (match[2] ? "earlier" : "current"));

test("from status to the page, a replacement Preview's own Services are current and an earlier one's are marked earlier", async () => {
  const { view, html } = await monitorPage("feature");
  expect(view.targetId).toBe("new");
  expect(cardsIn(html, "api")).toEqual(["current"]);
  expect(cardsIn(html, "web")).toEqual(["earlier"]);
});

test("from status to the page, every Target's view knows the replacement's series by the id status reports", async () => {
  const { view, html } = await monitorPage("all");
  expect(view.inventory).toEqual([{ name: "feature", targetId: "new" }]);
  // The earlier Preview's numbers are the larger; the chip shows the current one's.
  expect(
    view.targets.find((each) => each.name === "feature")?.detail,
  ).toStartWith("2");
  expect(cardsIn(html, "feature")).toEqual(["current", "earlier"]);
});

/** What a person can read on the page: its text, with no attribute such as a title, which a disabled control never shows. */
const readable = (html: string) => html.replace(/<[^>]*>/g, " ");
const says = (text: string, reason: string) => text.split(reason).length - 1;
const JOB = {
  name: "db-backup",
  schedule: "0 3 * * *",
  timeZone: "UTC",
  state: "idle",
  scheduled: false,
  backup: { keep: 3, restore: true, count: 1, bytes: 1 },
} as const;
const BACKUP = {
  target: "feature",
  job: "db-backup",
  id: "20261011T030000Z-1",
  path: "/rig/backups/1",
  run: "run-1",
  trigger: "schedule",
  startedAt: "2026-10-11T03:00:00.000Z",
  finishedAt: "2026-10-11T03:00:41.000Z",
} as const;
function jobCards(
  target: TargetReport,
  job: Parameters<typeof JobCards>[0]["jobs"][number] = JOB,
  backups: Parameters<typeof JobCards>[0]["backups"] = [BACKUP, BACKUP],
) {
  const router = { refresh() {}, push() {} } as never;
  return readable(
    renderToStaticMarkup(
      <AppRouterContext.Provider value={router}>
        <JobCards
          project="demo"
          target={target}
          jobs={[job]}
          backups={backups}
          now={0}
        />
      </AppRouterContext.Provider>,
    ),
  );
}

test("why Back up now and Restore are refused is readable on the page, once however many backups are listed", () => {
  const off = preview({ refusals: { run: OFF, restore: OFF } });
  expect(says(jobCards(off), OFF.message)).toBe(1);
  expect(says(jobCards(off), OFF.hint)).toBe(1);
  expect(says(jobCards(preview()), OFF.message)).toBe(0);
});

test("a reason only Restore has, and a reason about the job itself, are readable on the page too", () => {
  const noRestore = {
    ...JOB,
    backup: { keep: 3, restore: false, count: 1, bytes: 1 },
  };
  expect(jobCards(preview(), noRestore)).toContain("has no restore command");
  expect(jobCards(preview(), { ...JOB, state: "running" })).toContain(
    "runs never overlap",
  );
  // No backup is listed, so there is no Restore to explain.
  expect(jobCards(preview(), noRestore, [])).not.toContain(
    "has no restore command",
  );
});

test("a Target's page says what rigd refuses in words, once, and what it is running", () => {
  const { mounted } = actions({
    target: stable({ refusals: { up: OFF, restart: OFF, deploy: OFF } }),
  });
  const reason = `${OFF.message} ${OFF.hint}`;
  const warnings = elements(mounted.tree).filter(
    (each) => (each.type as { name?: string }).name === "Warning",
  );
  expect(warnings.map((each) => textOf(each))).toEqual([reason]);
  const working = actions({
    target: stable({ state: "stopped" }),
    work: { running: { operationId: "op-1", action: "up", phase: "building" } },
  });
  expect(textOf(working.mounted.tree)).toContain("up is running (building)");
});

test("a card has no room for words, so its menu, which a keyboard reaches, says why in full and what is running", () => {
  const refused = actions({
    layout: "card",
    stacked: false,
    target: stable({ state: "stopped", refusals: { up: OFF, deploy: OFF } }),
  });
  const trigger = (tree: unknown) =>
    elements(tree).find(
      (each) => each.props["aria-label"] === "Actions for stable",
    );
  expect(trigger(refused.mounted.tree)?.props.disabled).toBe(false);
  const item = refused
    .controls("Deploy latest")
    .find((each) => each.props.onSelect);
  expect(textOf(item)).toContain(OFF.message);
  expect(textOf(item)).toContain(OFF.hint);
  const working = actions({
    layout: "card",
    stacked: false,
    target: stable(),
    work: { running: { operationId: "op-1", action: "up", phase: "building" } },
  });
  expect(trigger(working.mounted.tree)?.props.disabled).toBe(false);
  expect(textOf(working.mounted.tree)).toContain("up is running (building)");
});

test("the last action is the last Activity recorded, even when the clock was set back between them", () => {
  const work = projectWork("demo", undefined, {
    operations: [
      record({
        id: "old-failure",
        message: "BUILD_FAILED",
        occurredAt: "2026-11-04T12:00:00.000Z",
      }),
      record({
        id: "later-success",
        action: "up",
        outcome: "started",
        occurredAt: "2026-11-04T11:00:00.000Z",
      }),
    ],
  });
  expect(work.stable?.last?.id).toBe("later-success");
  expect(lastActionText(work.stable!.last!)).toBe(
    "Activity's last action: started",
  );
});

const TIMEOUT = {
  code: "DAEMON_TIMEOUT",
  message: "The status read timed out.",
  hint: "Retry the read.",
};
/** rigd for a Project's pages: `status` is what its status read answers, or throws. */
const projectReads =
  (status: () => unknown) =>
  (command: RuntimeCommand): unknown => {
    if (command.action === "list")
      return {
        projects: [
          { id: "p", name: "demo", repoPath: "/repo", targetCount: 1 },
        ],
      };
    if (command.action === "status") return status();
    if (command.action === "deployments")
      return {
        project: "demo",
        deployments: [
          {
            id: "op-a",
            project: "demo",
            target: "stable",
            kind: "stable",
            branch: "main",
            commit: "a".repeat(40),
            outcome: "deployed",
            startedAt: "2026-10-10T10:00:00.000Z",
            finishedAt: "2026-10-10T10:00:05.000Z",
            durationMs: 5000,
          },
        ],
      };
    return {
      project: "demo",
      repoPath: "/repo",
      productionBranch: "main",
      currentBranch: "main",
      on: { working: true, stable: true, preview: true },
    };
  };
const timingOut = () => {
  throw Object.assign(new Error(TIMEOUT.message), TIMEOUT);
};
const inRouter = (page: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={{ refresh() {}, push() {} } as never}>
      {page}
    </AppRouterContext.Provider>,
  );
const params = Promise.resolve({ name: "demo" });
async function settingsPage(status: () => unknown) {
  answer = projectReads(status);
  const html = inRouter(await SettingsPage({ params }));
  answer = undefined;
  const disabled = Object.fromEntries(
    [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map((match) => [
      match[2],
      /\sdisabled(?:=|\s|$)/.test(match[1]!),
    ]),
  );
  return { text: readable(html), disabled };
}

test("a failed status leaves Settings unable to say what is allowed: it shows the failure and offers nothing, until a read succeeds", async () => {
  const blocked = await settingsPage(() => ({
    project: "demo",
    targets: [],
    refusals: { rename: ACTIVE, repoint: ACTIVE, forget: ACTIVE },
  }));
  expect(blocked.text).toContain(ACTIVE.message);
  const failed = await settingsPage(timingOut);
  expect(failed.text).toContain(TIMEOUT.message);
  expect(failed.text).toContain(TIMEOUT.code);
  for (const word of ["Rename", "Repoint", "Forget Project"])
    expect(failed.disabled[word]).toBe(true);
  // A status that succeeded with nothing refused is another thing: everything is open.
  const open = await settingsPage(() => ({ project: "demo", targets: [] }));
  expect(open.text).not.toContain(TIMEOUT.message);
  for (const word of ["Rename", "Repoint", "Forget Project"])
    expect(open.disabled[word]).toBe(false);
});

test("a failed status on the Deployments page says why no rollback is offered, and keeps the history", async () => {
  answer = projectReads(timingOut);
  const html = inRouter(await DeploymentsPage({ params }));
  answer = undefined;
  const text = readable(html);
  expect(text).toContain(TIMEOUT.message);
  expect(text).toContain("aaaaaaa");
  expect(text).not.toContain("Roll back to this");
});

/** A Target's actions after this page's own Start ended as `reply` said, with what rigd's record held before it. */
async function afterOwnStart(
  reply: (command: RuntimeCommand) => unknown,
  before?: ReturnType<typeof record>,
) {
  const props = {
    project: "demo",
    target: stable({ state: "stopped" }),
    layout: "buttons",
    stacked: true,
    ...(before ? { work: { last: before } } : {}),
  } as const;
  let sent: string | undefined;
  let refreshedBefore = 0;
  answer = (command) => {
    sent = command.operationId;
    return reply(command);
  };
  const { mounted, controls } = actions(props);
  mounted.act(() =>
    (
      controls("Start").find((each) => each.props.onClick)!.props
        .onClick as () => void
    )(),
  );
  await until(() => mounted.refreshes.count > 0);
  answer = undefined;
  mounted.render();
  const shown = (name: string, prop: string) =>
    elements(mounted.tree).find(
      (each) =>
        (each.type as { name?: string }).name === name &&
        each.props[prop] !== undefined,
    )?.props[prop];
  return {
    id: sent!,
    refreshed: (work: Props["work"]) =>
      mounted.render({ ...props, ...(work ? { work } : {}) }),
    /** Presses Start again, leaving its command in flight until `settled`. */
    sendAgain: () => {
      answer = replying("started");
      refreshedBefore = mounted.refreshes.count;
      mounted.act(() =>
        (
          controls("Start").find((each) => each.props.onClick)!.props
            .onClick as () => void
        )(),
      );
    },
    settled: async () => {
      await until(() => mounted.refreshes.count > refreshedBefore);
      answer = undefined;
    },
    notice: () => shown("OperationNotice", "result"),
    failure: () => shown("Failure", "failure"),
    text: () => textOf(mounted.tree),
  };
}
const LATER = record({
  id: "later-cli",
  message: "BUILD_FAILED",
  occurredAt: "2026-11-04T20:00:00.000Z",
});
const OWN_LABEL = "This page's last command";
const LATER_LINE = "Activity's last action: restart failed: BUILD_FAILED";
const DRAINING = refusing(
  "DAEMON_DRAINING",
  "rigd is preparing to stop.",
  "Wait for administration to complete before retrying.",
);

test("a later CLI failure is visible beside this page's own result, each saying what it is", async () => {
  const f = await afterOwnStart(replying("started"));
  expect(f.notice()).toMatchObject({ outcome: "started" });
  expect(f.text()).toContain(OWN_LABEL);
  f.refreshed({
    running: { operationId: "later-cli", action: "restart", phase: "building" },
  });
  expect(f.text()).toContain("restart is running (building)");
  f.refreshed({ last: LATER });
  expect(f.text()).toContain(LATER_LINE);
  expect(f.notice()).toMatchObject({ outcome: "started" });
  expect(f.text()).toContain(OWN_LABEL);
});

test("a fresh refusal stays visible with its full words, whatever Activity reports beside it", async () => {
  const before = record({ id: "earlier", message: "OLD_FAILURE" });
  const f = await afterOwnStart(DRAINING, before);
  const refused = {
    code: "DAEMON_DRAINING",
    hint: "Wait for administration to complete before retrying.",
  };
  expect(f.failure()).toMatchObject(refused);
  // An action the page had not seen, such as the command before this one recorded late; a later success; none at all.
  for (const work of [
    { last: record({ id: "first-of-two", outcome: "started" }) },
    { last: LATER },
    {},
    undefined,
  ]) {
    f.refreshed(work);
    expect(f.failure()).toMatchObject(refused);
  }
});

test("a refusal sent while Activity was unknown stays when Activity comes back", async () => {
  const f = await afterOwnStart(DRAINING);
  f.refreshed({ last: record({ id: "older", outcome: "started" }) });
  expect(f.failure()).toMatchObject({ code: "DAEMON_DRAINING" });
  expect(f.text()).toContain("Activity's last action: started");
});

test("a failed work read revives nothing false: only what this page got back stays, under its label", async () => {
  const f = await afterOwnStart(replying("started"));
  f.refreshed({ last: LATER });
  expect(f.text()).toContain(LATER_LINE);
  // projectWork answers no work when its reads fail.
  f.refreshed(projectWork("demo", undefined, undefined).stable);
  expect(f.notice()).toMatchObject({ outcome: "started" });
  expect(f.text()).toContain(OWN_LABEL);
  expect(f.text()).not.toContain("Activity's last action");
  f.refreshed({ last: LATER });
  expect(f.text()).toContain(LATER_LINE);
});

test("Activity's line is left out only when it is the very Operation this page's result or failure names", async () => {
  const succeeded = await afterOwnStart(replying("started"));
  succeeded.refreshed({
    last: record({ id: succeeded.id, action: "up", outcome: "started" }),
  });
  expect(succeeded.notice()).toMatchObject({ outcome: "started" });
  expect(succeeded.text()).not.toContain("Activity's last action");
  const named = await afterOwnStart((command) => {
    throw Object.assign(new Error("It failed."), {
      code: "INTERNAL",
      details: { operationId: command.operationId },
    });
  });
  named.refreshed({ last: record({ id: named.id, message: "INTERNAL" }) });
  expect(named.failure()).toMatchObject({ code: "INTERNAL" });
  expect(named.text()).not.toContain("Activity's last action");
  // A refusal that names no Operation cannot be proved the same, so both are said.
  const unnamed = await afterOwnStart(DRAINING);
  unnamed.refreshed({ last: record({ id: unnamed.id, message: "X" }) });
  expect(unnamed.failure()).toMatchObject({ code: "DAEMON_DRAINING" });
  expect(unnamed.text()).toContain("Activity's last action: restart failed: X");
});

test("this page's own outcome goes when the next command is sent, and a reload has none", async () => {
  const f = await afterOwnStart(replying("started"));
  expect(f.notice()).toBeDefined();
  f.sendAgain();
  expect(f.notice()).toBeUndefined();
  expect(f.text()).not.toContain(OWN_LABEL);
  await f.settled();
  const { mounted } = actions({
    target: stable({ state: "stopped" }),
    work: { last: LATER },
  });
  expect(textOf(mounted.tree)).not.toContain(OWN_LABEL);
  expect(textOf(mounted.tree)).toContain(LATER_LINE);
});

test("a card marks a failure from either fact, and its tooltip says which is which", async () => {
  const { mounted, controls } = actions({
    layout: "card",
    stacked: false,
    target: stable({ state: "stopped" }),
    work: { last: LATER },
  });
  const mark = () =>
    elements(mounted.tree).find(
      (each) => (each.type as { name?: string }).name === "OutcomeMark",
    )!;
  answer = replying("started");
  const before = mounted.refreshes.count;
  mounted.act(() =>
    (
      controls("Start").find((each) => each.props.onClick)!.props
        .onClick as () => void
    )(),
  );
  await until(() => mounted.refreshes.count > before);
  answer = undefined;
  mounted.render();
  expect(mark().props.result).toMatchObject({ outcome: "started" });
  expect(mark().props.last).toEqual(LATER);
  const rendered = renderToStaticMarkup(
    <AppRouterContext.Provider value={{ refresh() {}, push() {} } as never}>
      {mark() as never}
    </AppRouterContext.Provider>,
  );
  expect(rendered).toContain("started");
  expect(rendered).toContain("restart failed: BUILD_FAILED");
  expect(rendered).toContain("text-bad");
});

/** A card after this page's own Start ended as `reply` said, then a refresh brought `last`. */
async function cardAfterOwnStart(
  reply: (command: RuntimeCommand) => unknown,
  last: ReturnType<typeof record>,
) {
  const props = {
    project: "demo",
    layout: "card",
    stacked: false,
    target: stable({ state: "stopped" }),
  } as const;
  const { mounted, controls } = actions(props);
  answer = reply;
  mounted.act(() =>
    (
      controls("Start").find((each) => each.props.onClick)!.props
        .onClick as () => void
    )(),
  );
  await until(() => mounted.refreshes.count > 0);
  answer = undefined;
  mounted.render({ ...props, work: { last } });
  const dialog = markShown(
    elements(mounted.tree).find(
      (each) => (each.type as { name?: string }).name === "OutcomeMark",
    )!,
  );
  const button = elements(dialog.tree).find((each) => each.type === "button")!;
  return { text: textOf(dialog.tree), tone: String(button.props.className) };
}
const LATER_STOP = record({
  id: "later-cli",
  action: "down",
  outcome: "stopped",
});

test("a card's dialog says Activity's distinct success beside this page's failure, and the failure keeps the mark red", async () => {
  const { text, tone } = await cardAfterOwnStart(
    refusing("BUILD_FAILED", "The shared build failed.", "Fix the build."),
    LATER_STOP,
  );
  expect(text).toContain("This page's last command");
  expect(text).toContain("Activity's last action: stopped");
  expect(tone).toContain("text-bad");
});

test("a card's dialog says Activity's distinct success beside this page's success, and no failure leaves the mark green", async () => {
  const { text, tone } = await cardAfterOwnStart(
    replying("started"),
    LATER_STOP,
  );
  expect(text).toContain("This page's last command");
  expect(text).toContain("Activity's last action: stopped");
  expect(tone).toContain("text-good");
  expect(tone).not.toContain("text-bad");
});
