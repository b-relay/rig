import { expect, test } from "bun:test";
import type { Context, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { MenuButton, Navigation } from "../web/components/shell/navigation";
import { NavLink } from "../web/components/shell/nav-link";
import { Sheet, SheetContent } from "../web/components/ui/sheet";
import { elements, mountWithoutDom } from "./support/hook-harness";

/** The site's navigation: one sidebar, kept open beside the page on wide screens and in a drawer the top bar's button
 * opens on narrower ones. The drawer closes when a link in it is followed, to the page shown or another, when the page
 * changes, and when Radix asks (Escape, the overlay, its close button). The button is the drawer's Radix trigger, which
 * is what sets its expanded state and has Radix return focus to it when the drawer closes. */

const pathname = (path: string) =>
  new Map([[PathnameContext as Context<unknown>, path]]);
const sidebar = <nav aria-label="Projects" />;
const page = <div id="page" />;

function drawer(path = "/projects/pantry") {
  const contexts = pathname(path);
  const mounted = mountWithoutDom(Navigation, contexts);
  mounted.render({ sidebar, children: page });
  const root = () => mounted.tree as { props: Record<string, unknown> };
  const content = () =>
    elements(mounted.tree).find((each) => each.type === SheetContent)!;
  return {
    open: () => root().props.open as boolean,
    /** What Radix calls when the button is pressed, or Escape, the overlay or the close button closes the drawer. */
    radix: (open: boolean) =>
      mounted.act(() =>
        (root().props.onOpenChange as (open: boolean) => void)(open),
      ),
    /** A click inside the drawer, on a link or on anything else. */
    click: (onLink: boolean) =>
      mounted.act(() =>
        (content().props.onClick as (event: unknown) => void)({
          target: {
            closest: (selector: string) =>
              onLink && selector === "a" ? {} : null,
          },
        }),
      ),
    navigate: (to: string) => {
      contexts.set(PathnameContext as Context<unknown>, to);
      mounted.render();
    },
    content,
    tree: () => mounted.tree,
  };
}

test("the one sidebar is both the open sidebar and the drawer's content, around the page", () => {
  const nav = drawer();
  const aside = elements(nav.tree()).find((each) => each.type === "aside")!;
  expect(aside.props.children).toBe(sidebar);
  expect(
    elements(nav.content().props.children).filter((each) => each === sidebar),
  ).toHaveLength(1);
  expect(elements(nav.tree())).toContain(page);
});

test("a link followed in the drawer closes it, to the page shown or to another", () => {
  const nav = drawer();
  expect(nav.open()).toBe(false);
  nav.radix(true);
  expect(nav.open()).toBe(true);
  // A click on anything but a link leaves it open.
  nav.click(false);
  expect(nav.open()).toBe(true);
  // A link to the page shown changes no pathname: the click itself closes the drawer.
  nav.click(true);
  expect(nav.open()).toBe(false);
});

test("the drawer closes when the page changes, however it changed", () => {
  const nav = drawer();
  nav.radix(true);
  nav.navigate("/projects/ledger");
  expect(nav.open()).toBe(false);
  // Shown again on the new page, it stays until something closes it.
  nav.radix(true);
  nav.navigate("/projects/ledger");
  expect(nav.open()).toBe(true);
});

test("Escape, the overlay or the close button closes the drawer", () => {
  const nav = drawer();
  nav.radix(true);
  nav.radix(false);
  expect(nav.open()).toBe(false);
});

const shown = (node: ReactNode, path = "/") =>
  renderToStaticMarkup(
    <PathnameContext.Provider value={path}>{node}</PathnameContext.Provider>,
  );

test("the menu button is the drawer's trigger: it says whether the drawer is open and what it opens", () => {
  // Inside the navigation, as the top bar has it. Radix refuses a trigger outside its drawer's root.
  const closed = shown(
    <Navigation sidebar={sidebar}>
      <MenuButton />
    </Navigation>,
  );
  expect(closed).toContain('aria-label="Open the menu"');
  expect(closed).toContain('aria-haspopup="dialog"');
  expect(closed).toContain('aria-expanded="false"');
  // The first paint holds the sidebar once, beside the page; the closed drawer holds nothing yet.
  expect(closed.split('aria-label="Projects"')).toHaveLength(2);
  const open = shown(
    <Sheet open>
      <MenuButton />
    </Sheet>,
  );
  expect(open).toContain('aria-expanded="true"');
  expect(() => shown(<MenuButton />)).toThrow();
});

test("a sidebar link marks itself as the page shown, or one of its pages unless it is exact", () => {
  const link = (href: string, path: string, exact = false) => {
    const mounted = mountWithoutDom(NavLink, pathname(path));
    mounted.render({
      href,
      exact,
      className: "item",
      activeClassName: "active",
      children: href,
    });
    return (mounted.tree as { props: Record<string, unknown> }).props;
  };
  expect(link("/projects/pantry", "/projects/pantry", true)).toMatchObject({
    "aria-current": "page",
    className: "item active",
  });
  expect(
    link("/projects/pantry", "/projects/pantry/logs", true)["aria-current"],
  ).toBeUndefined();
  expect(
    link(
      "/projects/pantry/targets/stable",
      "/projects/pantry/targets/stable/logs",
    )["aria-current"],
  ).toBe("page");
  expect(link("/monitor", "/projects/pantry")).toMatchObject({
    "aria-current": undefined,
    className: "item",
  });
});
