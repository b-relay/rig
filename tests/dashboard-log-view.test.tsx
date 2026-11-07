import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
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
let storage: Map<string, string>;
let storageRefused: boolean;
const location = { pathname: "/projects/probe/logs", search: "", hash: "" };
beforeEach(() => {
  reads = [];
  answers = [];
  writes = [];
  followTimers = [];
  storage = new Map();
  storageRefused = false;
  location.search = "";
  (globalThis as { window?: unknown }).window = {
    location,
    // As a private window's or a blocked site's is, its very accessor can throw.
    get sessionStorage() {
      if (storageRefused) throw new Error("The operation is insecure.");
      return {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key),
      };
    },
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
  storage.set("rig.logs.search:/projects/probe/logs", "AUDIT-LINE-11999");
  const mounted = viewer(
    "lines=5000&paused=1&stream=stderr&component=web&nowrap=1",
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
  // A search may be a secret copied from the output: the address and its history never hold it.
  expect(writes).toEqual([]);
  mounted.act(
    labelled(mounted.tree, "Do not wrap long lines").props
      .onClick as () => void,
  );
  expect(writes.at(-1)).toBe("/projects/probe/logs?paused=1&nowrap=1");
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

test("a search stays out of the address and comes back on a reload of that page; clearing it keeps nothing", () => {
  const search = (mounted: ReturnType<typeof viewer>, value: string) =>
    mounted.act(() =>
      (
        labelled(mounted.tree, "Search the log").props.onChange as (event: {
          target: { value: string };
        }) => void
      )({ target: { value } }),
    );
  const first = viewer("paused=1", page(["served line"], "served"));
  search(first, "password=synthetic-secret");
  for (const url of [location.search, ...writes])
    expect(url).not.toContain("synthetic-secret");
  const reloaded = viewer("paused=1", page(["served line"], "served"));
  expect(labelled(reloaded.tree, "Search the log").props.value).toBe(
    "password=synthetic-secret",
  );
  // Another page's search is its own.
  location.pathname = "/projects/probe/targets/working/logs";
  const other = viewer("paused=1", page(["served line"], "served"));
  expect(labelled(other.tree, "Search the log").props.value).toBe("");
  location.pathname = "/projects/probe/logs";
  search(reloaded, "");
  expect(storage.size).toBe(0);
});

test("a browser that refuses storage opens with no search and can still search", () => {
  storageRefused = true;
  const mounted = viewer("paused=1", page(["served line", "other"], "served"));
  expect(labelled(mounted.tree, "Search the log").props.value).toBe("");
  mounted.act(() =>
    (
      labelled(mounted.tree, "Search the log").props.onChange as (event: {
        target: { value: string };
      }) => void
    )({ target: { value: "served" } }),
  );
  expect(labelled(mounted.tree, "Search the log").props.value).toBe("served");
  expect(textOf(mounted.tree)).not.toContain("other");
});

/** What the server sends and the browser first paints: the render before any effect runs. */
function firstPaint(address: string, first: LogsResult) {
  const router = { refresh() {}, push() {}, replace() {} };
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <SearchParamsContext.Provider
        value={new URLSearchParams(address) as never}
      >
        <LogViewer
          project="probe"
          targets={TARGETS}
          selected={undefined}
          first={first}
        />
      </SearchParamsContext.Provider>
    </AppRouterContext.Provider>,
  );
}

test("a saved search never flashes what it hides: the first paint holds no line, and the settled view only what matches", () => {
  storage.set("rig.logs.search:/projects/probe/logs", "needle");
  const first = page(["needle line", "UNFILTERED"], "served");
  const html = firstPaint("paused=1", first);
  expect(html).not.toContain("UNFILTERED");
  expect(html).not.toContain("needle line");
  // Nor does it say something untrue while it waits.
  expect(html).not.toContain("No lines yet");
  expect(html).not.toContain("No line matches");
  const text = textOf(viewer("paused=1", first).tree);
  expect(text).toContain("needle line");
  expect(text).not.toContain("UNFILTERED");
});

test.each([
  ["no saved search", false],
  ["storage refused", true],
])(
  "with %s, the lines come right after the attempt rather than staying withheld",
  (_what, refused) => {
    storageRefused = refused;
    const first = page(["served line"], "served");
    expect(firstPaint("paused=1", first)).not.toContain("served line");
    const text = textOf(viewer("paused=1", first).tree);
    expect(text).toContain("served line");
    expect(text).toContain("1 lines");
  },
);

test("a following view with a saved search keeps tailing, showing what matches as it arrives", async () => {
  storage.set("rig.logs.search:/projects/probe/logs", "needle");
  const mounted = viewer("", page(["needle 1", "other 1"], "c1"));
  answers = [{ ok: true, value: page(["needle 2", "other 2"], "c2") }];
  followTimers.pop()!();
  await settle(mounted);
  expect(reads.at(-1)).toMatchObject({ after: "c1" });
  const text = textOf(mounted.tree);
  expect(text).toContain("needle 1");
  expect(text).toContain("needle 2");
  expect(text).not.toContain("other");
  expect(text).toContain("2 of 4 lines");
});
