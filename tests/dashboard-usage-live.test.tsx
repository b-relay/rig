import { afterEach, beforeEach, expect, test } from "bun:test";
import { mountWithoutDom } from "./support/hook-harness";
import { useUsage, type UsageQuery } from "../web/components/usage-live";
import type { Failure } from "../web/lib/outcome";
import type { ChartReport } from "../web/lib/usage";

// #617: the Monitor pages' poll checks the report it is answered with before it draws it.

const realFetch = globalThis.fetch;
const realTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const previousDocument = (globalThis as { document?: unknown }).document;
let answers: unknown[];
let polls: (() => void)[];
beforeEach(() => {
  answers = [];
  polls = [];
  (globalThis as { document?: unknown }).document = {
    visibilityState: "visible",
  };
  // A Response is answered as it is, so a test can send what the site's route never would.
  globalThis.fetch = (async () => {
    const answer = answers.shift();
    return answer instanceof Response ? answer : Response.json(answer);
  }) as unknown as typeof fetch;
  globalThis.setTimeout = ((work: () => void) => {
    polls.push(work);
    return work;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realTimeout;
  globalThis.clearTimeout = realClearTimeout;
  (globalThis as { document?: unknown }).document = previousDocument;
});
const report = (sampledEvery: number): ChartReport => ({
  range: "1h",
  from: 6000,
  step: 10,
  sampledEvery,
  series: [
    {
      key: "host",
      series: { scope: "host" },
      now: { cpuPercent: 5, memoryBytes: 4096 },
      cpu: { average: [5, null], peak: { index: 0, value: 5 }, median: 5 },
      memory: { average: [4096, null] },
    },
  ],
});
/** A successful reply whose one series is `series`. */
const withSeries = (series: Record<string, unknown>) => ({
  ok: true,
  value: { ...report(1), series: [{ ...report(1).series[0], series }] },
});
const QUERY: UsageQuery = { host: true, range: "1h" };
function polled() {
  let shown: { report?: ChartReport; failure?: Failure } = {};
  const mounted = mountWithoutDom((props: { initial: ChartReport }) => {
    shown = useUsage(props.initial, QUERY);
    return null;
  });
  mounted.render({ initial: report(1) });
  const poll = async () => {
    polls.shift()!();
    for (let turn = 0; turn < 50; turn++) {
      await Promise.resolve();
      mounted.render();
    }
    return shown;
  };
  return { poll };
}

test.each([
  ["no report", { ok: true, value: null }],
  [
    "a pace that is text",
    { ok: true, value: { ...report(1), sampledEvery: "bad" } },
  ],
  [
    "a series without its measures",
    { ok: true, value: { ...report(1), series: [{ key: "host" }] } },
  ],
  ["a refusal without its code", { ok: false, failure: { message: "x" } }],
  ["a body that is not an outcome", { series: [] }],
  // A card names and colours a series by its identity, so one without it is no series a card can draw.
  ["a Project series without its Project", withSeries({ scope: "project" })],
  [
    "a Target series without its Target",
    withSeries({ scope: "target", projectId: "p1", project: "pantry" }),
  ],
  [
    "a Component series without its kind",
    withSeries({
      scope: "component",
      projectId: "p1",
      project: "pantry",
      targetId: "t1",
      target: "stable",
      targetKind: "stable",
      component: "web",
    }),
  ],
])(
  "a poll answered with %s is WEB_PROTOCOL and keeps the report it drew",
  async (_, answer) => {
    const usage = polled();
    answers = [answer];
    expect(await usage.poll()).toEqual({
      report: report(1),
      failure: {
        code: "WEB_PROTOCOL",
        message: "The usage read answered 200.",
        hint: "Reload the page; if it persists, restart the dashboard.",
      },
    });
    // The next good report is drawn, and clears the failure.
    answers = [{ ok: true, value: report(5) }];
    expect(await usage.poll()).toEqual({ report: report(5) });
  },
);

test("a poll's Project, Target and Component series are drawn as they came, with fields a newer rigd adds", async () => {
  const usage = polled();
  const target = {
    projectId: "p1",
    project: "pantry",
    targetId: "t1",
    target: "stable",
    targetKind: "stable",
  };
  const series = [
    { scope: "project", projectId: "p1", project: "pantry" },
    { scope: "target", ...target },
    {
      scope: "component",
      ...target,
      component: "web",
      componentKind: "service",
      added: 1,
    },
  ].map((identity, at) => ({
    ...report(1).series[0]!,
    key: String(at),
    series: identity,
  }));
  answers = [{ ok: true, value: { ...report(1), series } }];
  expect((await usage.poll()).report?.series).toEqual(series as never);
});

test("a poll answered with a refusal shows it and keeps the report; a page that is not JSON is WEB_PROTOCOL with its status", async () => {
  const usage = polled();
  const failure = { code: "MONITOR_UNAVAILABLE", message: "m", hint: "h" };
  answers = [{ ok: false, failure }];
  expect(await usage.poll()).toEqual({ report: report(1), failure });
  answers = [new Response("<html>Bad gateway</html>", { status: 502 })];
  expect((await usage.poll()).failure).toEqual({
    code: "WEB_PROTOCOL",
    message: "The usage read answered 502.",
    hint: "Reload the page; if it persists, restart the dashboard.",
  });
});
