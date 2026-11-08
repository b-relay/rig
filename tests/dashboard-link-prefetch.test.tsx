import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import NextLink from "next/link";
import Link from "../web/components/link";
import { mountWithoutDom } from "./support/hook-harness";

/** What a link prefetches: nothing for being on screen, so a live refresh does not prefetch every link of the page again;
 * its page once someone points at it, touches it or moves focus to it. */

const mount = (props: Record<string, unknown> = {}) => {
  const mounted = mountWithoutDom(Link);
  mounted.render({ href: "/projects/pantry", children: "pantry", ...props });
  return mounted;
};
const shown = (mounted: ReturnType<typeof mount>) =>
  mounted.tree as unknown as {
    type: unknown;
    props: Record<string, unknown> & { prefetch: unknown };
  };

test.each(["onMouseEnter", "onTouchStart", "onFocus"])(
  "a link prefetches nothing until %s says someone may follow it, then as Next would",
  (intent) => {
    const calls: string[] = [];
    const mounted = mount({ [intent]: () => calls.push(intent) });
    expect(shown(mounted).type).toBe(NextLink);
    expect(shown(mounted).props.prefetch).toBe(false);
    expect(shown(mounted).props.href).toBe("/projects/pantry");
    mounted.act(() =>
      (shown(mounted).props[intent] as (e: unknown) => void)({}),
    );
    expect(shown(mounted).props.prefetch).toBeNull();
    // The page's own handler still runs.
    expect(calls).toEqual([intent]);
    // A redraw keeps what the person showed.
    mounted.render();
    expect(shown(mounted).props.prefetch).toBeNull();
  },
);

test("a link that asks for a full prefetch gets it once someone shows intent", () => {
  const mounted = mount({ prefetch: true });
  expect(shown(mounted).props.prefetch).toBe(false);
  mounted.act(() => (shown(mounted).props.onFocus as (e: unknown) => void)({}));
  expect(shown(mounted).props.prefetch).toBe(true);
});

test("every link of the site is that link: none uses Next's own, which prefetches whatever is on screen", () => {
  const root = join(import.meta.dir, "..");
  const sources = [...new Bun.Glob("web/**/*.{ts,tsx}").scanSync(root)].filter(
    (path) =>
      path !== "web/components/link.tsx" &&
      !path.includes("node_modules") &&
      !path.startsWith("web/.next/"),
  );
  expect(sources.length).toBeGreaterThan(50);
  expect(
    sources.filter((path) =>
      readFileSync(join(root, path), "utf8").includes('"next/link"'),
    ),
  ).toEqual([]);
});
