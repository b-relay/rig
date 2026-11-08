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
const realClearTimeout = globalThis.clearTimeout;
const previousWindow = (globalThis as { window?: unknown }).window;
const previousDocument = (globalThis as { document?: unknown }).document;
/** The tab, which a test hides and shows as a browser does: the state, then the event. */
const tab = {
  visibilityState: "visible",
  listeners: new Set<() => void>(),
  addEventListener(name: string, listener: () => void) {
    if (name === "visibilitychange") tab.listeners.add(listener);
  },
  removeEventListener(name: string, listener: () => void) {
    if (name === "visibilitychange") tab.listeners.delete(listener);
  },
  turn(state: "visible" | "hidden") {
    tab.visibilityState = state;
    for (const listener of [...tab.listeners]) listener();
  },
};
let reads: Record<string, unknown>[];
let readSignals: (AbortSignal | undefined)[];
const HOLD = Symbol("hold");
let answers: unknown[];
let writes: string[];
let followTimers: (() => void)[];
let storage: Map<string, string>;
let storageRefused: boolean;
const location = { pathname: "/projects/probe/logs", search: "", hash: "" };
beforeEach(() => {
  reads = [];
  readSignals = [];
  answers = [];
  writes = [];
  followTimers = [];
  storage = new Map();
  storageRefused = false;
  location.search = "";
  tab.visibilityState = "visible";
  tab.listeners.clear();
  (globalThis as { document?: unknown }).document = tab;
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
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    reads.push(
      JSON.parse(
        new URL(input, "http://rig.test").searchParams.get("q")!,
      ) as Record<string, unknown>,
    );
    readSignals.push(init?.signal ?? undefined);
    // A read answered with HOLD stays in flight until its signal abandons it.
    if (answers[0] === HOLD) {
      answers.shift();
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    }
    // A Response is answered as it is, so a test can send what the site's route never would.
    const answer = answers.shift();
    return answer instanceof Response ? answer : Response.json(answer);
  }) as unknown as typeof fetch;
  // A timer is its own handle, so clearing it takes it off the list before it comes due, as a browser does.
  globalThis.setTimeout = ((work: () => void) => {
    const timer = () => work();
    followTimers.push(timer);
    return timer;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer: () => void) => {
    const at = followTimers.indexOf(timer);
    if (at !== -1) followTimers.splice(at, 1);
  }) as unknown as typeof clearTimeout;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realTimeout;
  globalThis.clearTimeout = realClearTimeout;
  (globalThis as { window?: unknown }).window = previousWindow;
  (globalThis as { document?: unknown }).document = previousDocument;
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

test("a reply the Logs page cannot read is WEB_PROTOCOL with its status and a hint, and keeps the lines and the cursor", async () => {
  const mounted = viewer("", page(["line 1"], "c1"));
  answers = [new Response("<html>Bad gateway</html>", { status: 502 })];
  followTimers.pop()!();
  await settle(mounted);
  expect(
    elements(mounted.tree).find((each) => each.props.failure)?.props.failure,
  ).toEqual({
    code: "WEB_PROTOCOL",
    message: "The log read answered 502.",
    hint: "Reload the page; if it persists, restart the dashboard.",
  });
  expect(textOf(mounted.tree)).toContain("line 1");
  // JSON that is not an outcome is no more readable than a page that is not JSON.
  answers = [{ entries: [] }];
  followTimers.pop()!();
  await settle(mounted);
  expect(
    elements(mounted.tree).find((each) => each.props.failure)?.props.failure,
  ).toMatchObject({
    code: "WEB_PROTOCOL",
    message: "The log read answered 200.",
  });
  answers = [{ ok: true, value: page(["line 2"], "c2") }];
  followTimers.pop()!();
  await settle(mounted);
  expect(reads.at(-1)).toMatchObject({ after: "c1" });
  expect(textOf(mounted.tree)).toContain("line 2");
});

test("a read that never reached the site is still UNREACHABLE", async () => {
  const mounted = viewer("", page(["line 1"], "c1"));
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  followTimers.pop()!();
  await settle(mounted);
  expect(
    elements(mounted.tree).find((each) => each.props.failure)?.props.failure,
  ).toMatchObject({ code: "UNREACHABLE", message: "Failed to fetch" });
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

/** Every line the viewer shows, by its number, in order. */
const numbered = (mounted: ReturnType<typeof viewer>) =>
  elements(elements(mounted.tree).find((each) => each.props.role === "log"))
    .map((each) => textOf(each.props.children))
    .filter((text) => /^line \d+$/.test(text))
    .map((text) => Number(text.slice(5)));
const followRead = (after: string) => ({
  project: "probe",
  target: "working",
  after,
  lines: 1000,
});

test("a hidden tab's follow reads nothing; shown again it reads on from its cursor at once, every line once", async () => {
  const mounted = viewer("", page(["line 1", "line 2"], "c2"));
  answers = [{ ok: true, value: page(["line 3"], "c3") }];
  followTimers.pop()!();
  await settle(mounted);
  expect(reads).toEqual([followRead("c2")]);
  tab.turn("hidden");
  // The timer set while visible comes due while hidden: it reads nothing and sets no other.
  followTimers.pop()!();
  await settle(mounted);
  expect(reads).toHaveLength(1);
  expect(followTimers).toEqual([]);
  // Lines written meanwhile come in one read from the cursor, then the follow goes on as before.
  answers = [{ ok: true, value: page(["line 4", "line 5", "line 6"], "c6") }];
  tab.turn("visible");
  await settle(mounted);
  expect(reads.at(-1)).toEqual(followRead("c3"));
  expect(numbered(mounted)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(followTimers).toHaveLength(1);
  // Shown again while already following, it reads nothing more: the timer is the only next read.
  tab.turn("visible");
  await settle(mounted);
  expect(reads).toHaveLength(2);
  answers = [{ ok: true, value: page(["line 7"], "c7") }];
  followTimers.pop()!();
  await settle(mounted);
  expect(reads.at(-1)).toEqual(followRead("c6"));
  expect(numbered(mounted)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test("a tab hidden and shown before its follow came due reads only when the timer does", async () => {
  const mounted = viewer("", page(["line 1"], "c1"));
  tab.turn("hidden");
  tab.turn("visible");
  await settle(mounted);
  expect(reads).toEqual([]);
  answers = [{ ok: true, value: page(["line 2"], "c2") }];
  followTimers.pop()!();
  await settle(mounted);
  expect(reads).toEqual([followRead("c1")]);
  expect(numbered(mounted)).toEqual([1, 2]);
});

test("a cursor that expired while the tab was hidden starts the view over on its return", async () => {
  const mounted = viewer("", page(["line 1"], "c1"));
  tab.turn("hidden");
  followTimers.pop()!();
  await settle(mounted);
  expect(reads).toEqual([]);
  answers = [
    {
      ok: false,
      failure: {
        code: "LOG_CURSOR",
        message: "The log has rotated past this cursor.",
        hint: "Read the newest lines again.",
      },
    },
  ];
  tab.turn("visible");
  await settle(mounted);
  expect(reads.at(-1)).toEqual(followRead("c1"));
  expect(numbered(mounted)).toEqual([]);
  answers = [{ ok: true, value: page(["line 40", "line 41"], "c41") }];
  followTimers.pop()!();
  await settle(mounted);
  expect(reads.at(-1)).toEqual({
    project: "probe",
    target: "working",
    lines: 200,
  });
  expect(numbered(mounted)).toEqual([40, 41]);
});

test("a paused view reads nothing when its tab is shown again, and Follow still resumes it", async () => {
  const mounted = viewer("paused=1", page(["line 1"], "c1"));
  tab.turn("hidden");
  tab.turn("visible");
  await settle(mounted);
  expect(reads).toEqual([]);
  expect(followTimers).toEqual([]);
  mounted.act(
    labelled(mounted.tree, "Follow new lines").props.onClick as () => void,
  );
  answers = [{ ok: true, value: page(["line 2"], "c2") }];
  followTimers.pop()!();
  await settle(mounted);
  expect(reads).toEqual([followRead("c1")]);
  expect(numbered(mounted)).toEqual([1, 2]);
  mounted.act(
    labelled(mounted.tree, "Pause following").props.onClick as () => void,
  );
  tab.turn("hidden");
  tab.turn("visible");
  await settle(mounted);
  expect(reads).toHaveLength(1);
});

test("leaving the page stops its follow: a timer still due reads nothing, nor does showing the tab, and a read in flight is abandoned", async () => {
  const waitingTimer = viewer("", page(["line 1"], "c1"));
  expect(followTimers).toHaveLength(1);
  waitingTimer.unmount();
  expect(followTimers).toEqual([]);
  await settle(waitingTimer);
  expect(reads).toEqual([]);

  const hidden = viewer("", page(["line 1"], "c1"));
  tab.turn("hidden");
  followTimers.pop()!();
  hidden.unmount();
  expect(tab.listeners.size).toBe(0);
  tab.turn("visible");
  await settle(hidden);
  expect(reads).toEqual([]);

  const reading = viewer("", page(["line 1"], "c1"));
  answers = [HOLD];
  followTimers.pop()!();
  expect(reads).toHaveLength(1);
  expect(readSignals[0]!.aborted).toBe(false);
  reading.unmount();
  expect(readSignals[0]!.aborted).toBe(true);
  await settle(reading);
  // The abandoned read sets no further timer, and says nothing went wrong.
  expect(followTimers).toEqual([]);
  expect(
    elements(reading.tree).find((each) => each.props.failure),
  ).toBeUndefined();
});

test("another Target's view takes the follow over: the first one's timer and tab listener are gone, and only the new one reads", async () => {
  const both = [
    ...TARGETS,
    { name: "stable", kind: "stable" as const, components: COMPONENTS },
  ];
  const mounted = mountWithoutDom(LogViewer);
  (SearchParamsContext as unknown as { _currentValue: unknown })._currentValue =
    new URLSearchParams();
  mounted.render({
    project: "probe",
    targets: both,
    selected: undefined,
    first: page(["line 1"], "c1"),
  });
  expect(followTimers).toHaveLength(1);
  tab.turn("hidden");
  const stable = (lines: string[], cursor: string) => ({
    ok: true,
    value: { ...page(lines, cursor), target: "stable" },
  });
  // The server sends the stable Target's first page with the new address, which the view adopts.
  mounted.render({
    project: "probe",
    targets: both,
    selected: "stable:stable",
    first: stable(["line 7"], "s7").value,
  });
  await settle(mounted);
  expect(reads).toEqual([]);
  // The working Target's timer and listener went with its view: one of each is left, the stable Target's.
  expect(followTimers).toHaveLength(1);
  expect(tab.listeners.size).toBe(1);
  followTimers.pop()!();
  answers = [stable(["line 8"], "s8")];
  tab.turn("visible");
  await settle(mounted);
  expect(reads).toEqual([
    { project: "probe", target: "stable", after: "s7", lines: 1000 },
  ]);
  expect(numbered(mounted)).toEqual([7, 8]);
});
