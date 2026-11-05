import { afterEach, beforeEach, expect, test } from "bun:test";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { LogViewer } from "../web/components/log-viewer";
import { logViewOf, logViewParams, type LogView } from "../web/lib/logs";
import type { LogsResult } from "../web/lib/types";
import {
  elements,
  labelled,
  mountWithoutDom,
  textOf,
} from "./support/hook-harness";

/** The Logs viewing controls: what an address asks for, and the mounted viewer that reads it, writes it, and keeps its place
 * across a refused read. Reads and timers are stood in for, so no clock is waited on. */

const COMPONENTS = ["web", "worker", "setup"];
const DEFAULTS: LogView = {
  lines: 200,
  follow: true,
  query: { services: [] },
  search: "",
  wrap: true,
};
const entry = (line: string, stream: "stdout" | "stderr" = "stdout") => ({
  timestamp: "2026-11-05T10:00:00.000Z",
  component: "web",
  stream,
  line,
});
const page = (lines: string[], cursor: string): LogsResult => ({
  project: "probe",
  target: "working",
  entries: lines.map((line) => entry(line)),
  cursor,
});
const TARGETS = [
  { name: "working", kind: "working" as const, components: COMPONENTS },
];

test("an address with no view, or one that cannot be read, opens the defaults", () => {
  expect(logViewOf(new URLSearchParams(), COMPONENTS)).toEqual(DEFAULTS);
  expect(
    logViewOf(
      new URLSearchParams(
        "lines=7&stream=everything&component=gone&paused=maybe&nowrap=0",
      ),
      COMPONENTS,
    ),
  ).toEqual(DEFAULTS);
});

test("a view survives the address and back, and a default adds nothing to it; other parameters stay", () => {
  const view: LogView = {
    lines: 5000,
    follow: false,
    query: { services: ["web", "worker"], stream: "stderr" },
    search: "AUDIT-LINE 11999",
    wrap: false,
  };
  const address = logViewParams(view, new URLSearchParams("target=stable"));
  expect(address.get("target")).toBe("stable");
  expect(logViewOf(address, COMPONENTS)).toEqual(view);
  // Back to the defaults, only the Target stays.
  expect(logViewParams(DEFAULTS, address).toString()).toBe("target=stable");
});

// What the viewer reaches of a browser: the address, its reads, and the timer a follow waits on.
const realFetch = globalThis.fetch;
const realTimeout = globalThis.setTimeout;
const previousWindow = (globalThis as { window?: unknown }).window;
let reads: Record<string, unknown>[];
let answers: unknown[];
let writes: string[];
let followTimers: (() => void)[];
const location = { pathname: "/projects/probe/logs", search: "", hash: "" };
beforeEach(() => {
  reads = [];
  answers = [];
  writes = [];
  followTimers = [];
  location.search = "";
  (globalThis as { window?: unknown }).window = {
    location,
    history: {
      replaceState(_state: unknown, _title: string, url: string) {
        writes.push(url);
        location.search = url.slice(
          url.indexOf("?") === -1 ? url.length : url.indexOf("?"),
        );
      },
    },
  };
  globalThis.fetch = (async (input: string) => {
    reads.push(
      JSON.parse(
        new URL(input, "http://rig.test").searchParams.get("q")!,
      ) as Record<string, unknown>,
    );
    return Response.json(answers.shift());
  }) as unknown as typeof fetch;
  globalThis.setTimeout = ((work: () => void) => {
    followTimers.push(work);
    return 0;
  }) as unknown as typeof setTimeout;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realTimeout;
  (globalThis as { window?: unknown }).window = previousWindow;
  (SearchParamsContext as unknown as { _currentValue: unknown })._currentValue =
    null;
});
function viewer(address: string, first: LogsResult | undefined) {
  location.search = address ? `?${address}` : "";
  (SearchParamsContext as unknown as { _currentValue: unknown })._currentValue =
    new URLSearchParams(address);
  const mounted = mountWithoutDom(LogViewer);
  mounted.render({
    project: "probe",
    targets: TARGETS,
    selected: undefined,
    first,
  });
  return mounted;
}
/** Lets the read in flight answer; no clock is involved. */
async function settle(mounted: ReturnType<typeof viewer>) {
  for (let turn = 0; turn < 50; turn++) {
    await Promise.resolve();
    mounted.render();
  }
}

test("a reloaded view opens as it was set: paused, wrapped as chosen, searched, reading the lines it asked for, and never the unfiltered first page", async () => {
  answers = [
    {
      ok: true,
      value: {
        ...page(["old AUDIT-LINE-11999", "other"], "c1"),
        filtered: true,
      },
    },
  ];
  const mounted = viewer(
    "lines=5000&paused=1&stream=stderr&component=web&search=AUDIT-LINE-11999&nowrap=1",
    page(["newest unfiltered line"], "served"),
  );
  // The first paint holds nothing of a page the view did not ask for.
  expect(textOf(mounted.tree)).not.toContain("newest unfiltered line");
  expect(reads).toEqual([
    {
      project: "probe",
      target: "working",
      lines: 5000,
      logFilter: { services: ["web"], stream: "stderr" },
    },
  ]);
  expect(labelled(mounted.tree, "Search the log").props.value).toBe(
    "AUDIT-LINE-11999",
  );
  // Wrapping was turned off, so the control offers to turn it on.
  labelled(mounted.tree, "Wrap long lines");
  await settle(mounted);
  expect(textOf(mounted.tree)).toContain("AUDIT-LINE-11999");
  expect(textOf(mounted.tree)).not.toContain("other");
  expect(textOf(mounted.tree)).toContain("Paused");
  // A paused view does not resume on its own.
  expect(followTimers).toEqual([]);
  // Reading the address changes nothing in it.
  expect(writes).toEqual([]);
});

test("a new view adopts the server's first page without another read, and its address stays bare", () => {
  const mounted = viewer("paused=1", page(["served line"], "served"));
  expect(textOf(mounted.tree)).toContain("served line");
  expect(reads).toEqual([]);
  expect(writes).toEqual([]);
});

test("a control's change goes to the address without a router navigation, and back to the default takes it out", () => {
  const mounted = viewer("paused=1", page(["served line"], "served"));
  mounted.act(() =>
    (
      labelled(mounted.tree, "Search the log").props.onChange as (event: {
        target: { value: string };
      }) => void
    )({ target: { value: "needle" } }),
  );
  expect(writes.at(-1)).toBe("/projects/probe/logs?paused=1&search=needle");
  mounted.act(
    labelled(mounted.tree, "Do not wrap long lines").props
      .onClick as () => void,
  );
  expect(writes.at(-1)).toBe(
    "/projects/probe/logs?paused=1&search=needle&nowrap=1",
  );
  mounted.act(() =>
    (
      labelled(mounted.tree, "Search the log").props.onChange as (event: {
        target: { value: string };
      }) => void
    )({ target: { value: "" } }),
  );
  mounted.act(
    labelled(mounted.tree, "Wrap long lines").props.onClick as () => void,
  );
  mounted.act(
    labelled(mounted.tree, "Follow new lines").props.onClick as () => void,
  );
  expect(writes.at(-1)).toBe("/projects/probe/logs");
  expect(mounted.refreshes.count).toBe(0);
  expect(mounted.pushes).toEqual([]);
});

test("a read refused while rigd is down keeps the lines and the cursor, and the next read resumes from it, each line once", async () => {
  const mounted = viewer("", page(["line 1", "line 2"], "c2"));
  expect(followTimers.length).toBeGreaterThan(0);
  answers = [
    {
      ok: false,
      failure: {
        code: "DAEMON_MISSING",
        message: "rigd is not running.",
        hint: "Run rigd status.",
      },
    },
  ];
  followTimers.pop()!();
  await settle(mounted);
  expect(reads.at(-1)).toMatchObject({ after: "c2" });
  expect(textOf(mounted.tree)).toContain("line 2");
  expect(
    elements(mounted.tree).find((each) => each.props.failure)?.props.failure,
  ).toMatchObject({ code: "DAEMON_MISSING" });
  answers = [{ ok: true, value: page(["line 3", "line 4"], "c4") }];
  followTimers.pop()!();
  await settle(mounted);
  expect(reads.at(-1)).toMatchObject({ after: "c2" });
  const text = textOf(mounted.tree);
  for (const line of ["line 1", "line 2", "line 3", "line 4"])
    expect(text.split(line).length).toBe(2);
  expect(
    elements(mounted.tree).find((each) => each.props.failure)?.props.failure,
  ).toBeUndefined();
});

test("a cursor rigd says will never be valid again starts over, unlike a read that failed in transit", async () => {
  const mounted = viewer("", page(["line 1"], "c1"));
  answers = [
    {
      ok: false,
      failure: {
        code: "TARGET_MISSING",
        message: "No such Target.",
        hint: "Deploy it.",
      },
    },
  ];
  followTimers.pop()!();
  await settle(mounted);
  expect(textOf(mounted.tree)).not.toContain("line 1");
  answers = [{ ok: true, value: page(["fresh"], "c9") }];
  followTimers.pop()!();
  await settle(mounted);
  expect(reads.at(-1)).not.toHaveProperty("after");
  expect(textOf(mounted.tree)).toContain("fresh");
});
