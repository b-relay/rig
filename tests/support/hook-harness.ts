import * as React from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { ReactNode } from "react";

/** A client component driven without a DOM: it is called as a function with React's hooks answered here, so a test can
 * run its handlers and render it again with new props, as a refresh does, and read what it would show. Child components
 * are not rendered; their elements and props are what the test reads. State and effects persist between renders, as
 * they do for a mounted component; `router.refresh()` and `router.push()` are recorded. */
export function mountWithoutDom<P>(
  component: (props: P) => ReactNode,
  /** Values the component reads from these contexts, such as Next's pathname; a test may change them between renders. */
  contexts: ReadonlyMap<React.Context<unknown>, unknown> = new Map(),
) {
  const states: unknown[] = [];
  const effectDeps: (readonly unknown[] | undefined)[] = [];
  const cleanups = new Map<number, () => void>();
  let queued: (() => void)[] = [];
  let cursor = 0;
  let effectCursor = 0;
  let changed = false;
  let props: P;
  let tree: ReactNode;
  const refreshes = { count: 0 };
  const pushes: string[] = [];
  const router = {
    refresh: () => void refreshes.count++,
    push: (href: string) => void pushes.push(href),
  };
  const dispatcher = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in states))
        states[index] =
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial;
      const set = (next: unknown) => {
        states[index] =
          typeof next === "function"
            ? (next as (now: unknown) => unknown)(states[index])
            : next;
        changed = true;
      };
      return [states[index], set];
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
      const index = effectCursor++;
      const before = effectDeps[index];
      if (
        !deps ||
        !before ||
        deps.some((value, at) => !Object.is(value, before[at]))
      ) {
        effectDeps[index] = deps;
        // As React does: the effect's last cleanup runs before it runs again.
        queued.push(() => {
          cleanups.get(index)?.();
          const cleanup = effect();
          if (typeof cleanup === "function") cleanups.set(index, cleanup);
          else cleanups.delete(index);
        });
      }
    },
    useContext(context: React.Context<unknown>) {
      if (contexts.has(context)) return contexts.get(context);
      return context === (AppRouterContext as React.Context<unknown>)
        ? router
        : (context as unknown as { _currentValue: unknown })._currentValue;
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in states)) states[index] = { current: initial };
      return states[index];
    },
    // As React does, a value is made again only when its deps change, so an effect that depends on it is not run again.
    useMemo(make: () => unknown, deps?: readonly unknown[]) {
      const index = cursor++;
      const before = states[index] as
        { value: unknown; deps?: readonly unknown[] } | undefined;
      if (
        !before ||
        !deps ||
        !before.deps ||
        deps.some((value, at) => !Object.is(value, before.deps![at]))
      )
        states[index] = { value: make(), deps };
      return (states[index] as { value: unknown }).value;
    },
    useCallback(callback: unknown, deps?: readonly unknown[]) {
      return dispatcher.useMemo(() => callback, deps);
    },
    use: (context: React.Context<unknown>) =>
      (context as unknown as { _currentValue: unknown })._currentValue,
    useId: () => "harness-id",
    useTransition: () => [false, (work: () => void) => work()],
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
      snapshot(),
  };
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
        H: unknown;
      };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  function renderOnce() {
    cursor = 0;
    effectCursor = 0;
    const previous = internals.H;
    internals.H = dispatcher;
    try {
      tree = component(props);
    } finally {
      internals.H = previous;
    }
  }
  /** Renders with `next` props (the last ones by default), runs the effects that render asked for, and renders again
   * while they change state. */
  function render(next: P = props): ReactNode {
    props = next;
    for (let pass = 0; pass < 10; pass++) {
      changed = false;
      renderOnce();
      const effects = queued;
      queued = [];
      for (const effect of effects) effect();
      if (!changed) return tree;
    }
    throw new Error("The component kept changing its state as it rendered.");
  }
  /** Runs a handler, as a click or keystroke does, then renders. */
  function act(handler: () => unknown): ReactNode {
    handler();
    return render();
  }
  /** Takes the component away, as leaving its page does: every effect's last cleanup runs. */
  function unmount() {
    for (const cleanup of cleanups.values()) cleanup();
    cleanups.clear();
  }
  return {
    render,
    act,
    unmount,
    refreshes,
    pushes,
    get tree() {
      return tree;
    },
  };
}
type Element = { type: unknown; props: Record<string, unknown> };
/** Every element of a rendered tree, depth first. */
export function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
/** The text a rendered node holds. */
export function textOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (node && typeof node === "object" && "props" in node)
    return textOf((node as Element).props.children);
  return "";
}
/** The element labelled `label` (by aria-label or a `label` prop), which a test acts on. */
export function labelled(tree: unknown, label: string): Element {
  const found = elements(tree).find(
    (each) => each.props["aria-label"] === label || each.props.label === label,
  );
  if (!found) throw new Error(`Nothing is labelled ${label}.`);
  return found;
}
/** Whether anything is labelled `label`. */
export const hasLabel = (tree: unknown, label: string): boolean =>
  elements(tree).some(
    (each) => each.props["aria-label"] === label || each.props.label === label,
  );
