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
/** Reads on mount, whenever `key` changes, and every `everyMs` when given. A failed poll keeps
 * the last data and reports the error beside it. */
export function useRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  key: string,
  everyMs?: number,
): Read<T> {
  const [state, setState] = useState<{
    key: string;
    data?: T;
    error?: unknown;
    loading: boolean;
  }>({ key, loading: true });
  const [turn, setTurn] = useState(0);
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((previous) => ({ ...previous, loading: true }));
    const once = async () => {
      try {
        const data = await latest.current(abort.signal);
        if (!abort.signal.aborted)
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
  }, [key, everyMs, turn]);
  const reload = useCallback(() => setTurn((value) => value + 1), []);
  const current = state.key === key;
  return {
    data: current ? state.data : undefined,
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
