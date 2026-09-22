import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { RigdApi } from "./api";

export const ApiContext = createContext<RigdApi | undefined>(undefined);
export function useApi(): RigdApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("The dashboard is not connected to rigd.");
  return api;
}
export interface Read<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload(): void;
}
/** Where the last answer to each read is kept between views and page loads. */
export interface Snapshots {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  /** Drops every snapshot, for when the browser is no longer signed in to this daemon. */
  forget(): void;
}
/** Bump when a read's answer changes shape, so a dashboard never paints an older build's snapshot. */
export const SNAPSHOT_FORMAT = 1;
export type SnapshotStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;
/** Snapshots in this tab's session storage, so a view paints its last answer at once and refreshes
 * behind it; closing the tab forgets them. A browser that refuses storage keeps them in memory. */
export function sessionSnapshots(
  storage: SnapshotStorage | undefined,
  prefix = `rig-dashboard:${SNAPSHOT_FORMAT}:`,
): Snapshots {
  const memory = new Map<string, unknown>();
  return {
    get(key) {
      if (memory.has(key)) return memory.get(key);
      try {
        const raw = storage?.getItem(prefix + key);
        return raw === null || raw === undefined ? undefined : JSON.parse(raw);
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      memory.set(key, value);
      try {
        storage?.setItem(prefix + key, JSON.stringify(value));
      } catch {
        // Full or refused storage only costs the next page load its head start.
      }
    },
    forget() {
      memory.clear();
      try {
        const mine: string[] = [];
        for (let i = 0; i < (storage?.length ?? 0); i++) {
          const name = storage?.key(i);
          if (name?.startsWith(prefix)) mine.push(name);
        }
        for (const name of mine) storage?.removeItem(name);
      } catch {
        // Nothing to forget in a browser that refused storage.
      }
    },
  };
}
export const SnapshotContext = createContext<Snapshots>(
  sessionSnapshots(undefined),
);
/** Reads on mount, whenever `key` changes, and every `everyMs` when given. A failed poll keeps
 * the last data and reports the error beside it. The last answer for `key` is shown at once
 * while the first read is in flight. */
export function useRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  key: string,
  everyMs?: number,
): Read<T> {
  const snapshots = useContext(SnapshotContext);
  const [state, setState] = useState<{
    key: string;
    data?: T;
    error?: unknown;
    loading: boolean;
  }>(() => ({ key, data: snapshots.get(key) as T | undefined, loading: true }));
  const [turn, setTurn] = useState(0);
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((previous) =>
      previous.key === key
        ? { ...previous, loading: true }
        : { key, data: snapshots.get(key) as T | undefined, loading: true },
    );
    const once = async () => {
      try {
        const data = await latest.current(abort.signal);
        if (abort.signal.aborted) return;
        snapshots.set(key, data);
        setState({ key, data, error: undefined, loading: false });
      } catch (error) {
        if (!abort.signal.aborted)
          setState((previous) => ({
            key,
            ...(previous.key === key ? { data: previous.data } : {}),
            error,
            loading: false,
          }));
      }
      if (everyMs && !abort.signal.aborted) timer = setTimeout(once, everyMs);
    };
    void once();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [key, everyMs, turn, snapshots]);
  const reload = useCallback(() => setTurn((value) => value + 1), []);
  const current = state.key === key;
  return {
    data: current ? state.data : (snapshots.get(key) as T | undefined),
    error: current ? state.error : undefined,
    loading: !current || state.loading,
    reload,
  };
}
export interface Act<T> {
  busy: boolean;
  error: unknown;
  result: T | undefined;
  run(action: () => Promise<T>): Promise<T | undefined>;
  clear(): void;
}
/** One user-started request at a time; its refusal is kept for display, never thrown at the caller. */
export function useAct<T>(): Act<T> {
  const [state, setState] = useState<{
    busy: boolean;
    error?: unknown;
    result?: T;
  }>({ busy: false });
  const run = useCallback(async (action: () => Promise<T>) => {
    setState({ busy: true });
    try {
      const result = await action();
      setState({ busy: false, result });
      return result;
    } catch (error) {
      setState({ busy: false, error });
      return undefined;
    }
  }, []);
  const clear = useCallback(() => setState({ busy: false }), []);
  return {
    busy: state.busy,
    error: state.error,
    result: state.result,
    run,
    clear,
  };
}
/** The hash route as path segments: `#/projects/pantry/logs` is `["projects","pantry","logs"]`. */
export function useRoute(): string[] {
  const read = () =>
    window.location.hash
      .replace(/^#\/?/, "")
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const changed = () => setRoute(read());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  return route;
}
export const href = (...segments: string[]) =>
  `#/${segments.map(encodeURIComponent).join("/")}`;
