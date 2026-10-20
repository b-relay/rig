import * as React from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { ReactNode } from "react";

/** A client component driven without a DOM: it is called as a function with React's hooks answered here, so a test can
 * run its handlers and render it again with new props, as a refresh does, and read what it would show. Child components
 * are not rendered; their elements and props are what the test reads. State and effects persist between renders, as
 * they do for a mounted component; `router.refresh()` is recorded. */
export function mountWithoutDom<P>(component: (props: P) => ReactNode) {
  const states: unknown[] = [];
  const effectDeps: (readonly unknown[] | undefined)[] = [];
  let queued: (() => void)[] = [];
  let cursor = 0;
  let effectCursor = 0;
  let changed = false;
  let props: P;
  let tree: ReactNode;
  const refreshes = { count: 0 };
  const router = { refresh: () => void refreshes.count++ };
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
    useEffect(effect: () => void, deps?: readonly unknown[]) {
      const index = effectCursor++;
      const before = effectDeps[index];
      if (
        !deps ||
        !before ||
        deps.some((value, at) => !Object.is(value, before[at]))
      ) {
        effectDeps[index] = deps;
        queued.push(effect);
      }
    },
    useContext(context: React.Context<unknown>) {
      return context === (AppRouterContext as React.Context<unknown>)
        ? router
        : (context as unknown as { _currentValue: unknown })._currentValue;
    },
    useMemo: (make: () => unknown) => make(),
    useCallback: (callback: unknown) => callback,
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
  return {
    render,
    act,
    refreshes,
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
