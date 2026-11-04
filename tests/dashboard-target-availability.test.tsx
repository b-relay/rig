import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { basic, local } from "./support/dashboard-site";
import { elements, mountWithoutDom, textOf } from "./support/hook-harness";
import type { RuntimeCommand } from "../src/daemon/protocol";
import * as daemon from "../web/server/daemon";
import { TargetActions } from "../web/components/target-actions";
import { SettingsForms } from "../web/components/settings-forms";
import { Confirm } from "../web/components/confirm";
import {
  completedNotice,
  lastActionText,
  projectWork,
  recordedFailure,
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
    "Last action: restart failed: BUILD_FAILED",
  );
  expect(recordedFailure(failed)).toMatchObject({
    message: "BUILD_FAILED",
    operationId: "op-fail",
  });
  const { mounted } = actions({
    target: stable({ state: "stopped" }),
    work: work.stable!,
  });
  expect(textOf(mounted.tree)).toContain(
    "Last action: restart failed: BUILD_FAILED",
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
  expect(recordedFailure(ok.stable!.last!)).toBeUndefined();
  expect(lastActionText(ok.stable!.last!)).toBe("Last action: started");
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
  expect(mark?.props.failure).toMatchObject({ message: "BUILD_FAILED" });
  const fine = actions({
    layout: "card",
    stacked: false,
    target: stable(),
    work: { last: record({ outcome: "started" }) },
  });
  expect(
    elements(fine.mounted.tree).find(
      (each) => (each.type as { name?: string }).name === "OutcomeMark",
    )?.props.failure,
  ).toBeUndefined();
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

test("with nothing refused, or no status to tell, every registration control is enabled and rigd decides", () => {
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
