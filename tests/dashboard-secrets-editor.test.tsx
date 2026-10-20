import { expect, test } from "bun:test";
import {
  elements,
  hasLabel,
  labelled,
  mountWithoutDom,
  textOf,
} from "./support/hook-harness";
import { SecretsEditor } from "../web/components/secrets-editor";
import type { EnvFileView } from "../web/lib/types";

/** The Environment editor's own handlers, driven as an operator would, with refreshes handing it newer files between
 * keystrokes. Nothing here reaches rigd: what is checked is what the editor would save against, and what it shows. */

const file = (revision: string, keys = ["A", "B"]): EnvFileView => ({
  scope: {},
  path: "/rig/env/demo/all.env",
  exists: true,
  revision,
  keys,
});
function editor(first: EnvFileView) {
  const mounted = mountWithoutDom(SecretsEditor);
  mounted.render({ project: "demo", file: first, readers: [] });
  const refresh = (next: EnvFileView) =>
    mounted.render({ project: "demo", file: next, readers: [] });
  const type = (label: string, value: string) =>
    mounted.act(() =>
      (
        labelled(mounted.tree, label).props.onChange as (event: {
          target: { value: string };
        }) => void
      )({ target: { value } }),
    );
  const click = (label: string) =>
    mounted.act(() =>
      (labelled(mounted.tree, label).props.onClick as () => void)(),
    );
  /** Presses Keep (or Enter) in the form holding the field labelled `label`. */
  const keep = (label: string) => {
    const form = elements(mounted.tree).find(
      (each) =>
        each.type === "form" &&
        elements(each.props.children).some(
          (child) => child.props["aria-label"] === label,
        ),
    )!;
    mounted.act(() =>
      (form.props.onSubmit as (event: { preventDefault(): void }) => void)({
        preventDefault() {},
      }),
    );
  };
  const text = () => textOf(mounted.tree);
  /** Whether the footer asks for a review against the current file: the draft is stale against the file shown. */
  const stale = () => text().includes("Review against the current file");
  return { mounted, refresh, type, click, keep, text, stale };
}

test("a value typed while another writer removes the name stays on screen until Keep or Cancel, and Keep leaves it stale", () => {
  const page = editor(file("R0"));
  page.click("Edit A");
  page.type("New value for A", "must-survive-removal");
  page.refresh(file("R1", ["B"]));
  // The row, its field and its Keep stay, marked as gone from the file, with nothing else to do to a name that is not there.
  expect(hasLabel(page.mounted.tree, "New value for A")).toBe(true);
  expect(page.text()).toContain("no longer in the file");
  expect(hasLabel(page.mounted.tree, "Edit A")).toBe(false);
  expect(hasLabel(page.mounted.tree, "Reveal A")).toBe(false);
  expect(labelled(page.mounted.tree, "New value for A").props.value).toBe(
    "must-survive-removal",
  );
  page.keep("New value for A");
  expect(page.text()).toContain("1 unsaved change");
  expect(page.text()).toContain("It no longer assigns A.");
  expect(page.stale()).toBe(true);
  // Cancel instead drops the row of a removed name.
  const cancelled = editor(file("R0"));
  cancelled.click("Edit A");
  cancelled.refresh(file("R1", ["B"]));
  const cancel = elements(cancelled.mounted.tree).find(
    (each) => textOf(each) === "Cancel" && each.props.onClick,
  )!;
  cancelled.mounted.act(cancel.props.onClick as () => void);
  expect(hasLabel(cancelled.mounted.tree, "New value for A")).toBe(false);
  expect(cancelled.text()).not.toContain("no longer in the file");
  expect(cancelled.text()).not.toContain("unsaved");
});

test("an edit or a new name keeps the file shown when its typing began, whichever comes first, the refresh or the keystroke", () => {
  // Edit, type, then a refresh before Keep.
  const typed = editor(file("R0"));
  typed.click("Edit A");
  typed.type("New value for A", "draft-started-on-R0");
  typed.refresh(file("R1"));
  typed.keep("New value for A");
  expect(typed.stale()).toBe(true);
  // Edit, a refresh, then a paste.
  const pasted = editor(file("R0"));
  pasted.click("Edit A");
  pasted.refresh(file("R1"));
  pasted.type("New value for A", "pasted-after-refresh");
  pasted.keep("New value for A");
  expect(pasted.stale()).toBe(true);
  // A new name whose value was typed first, then a refresh, then its name.
  const added = editor(file("R0"));
  added.type("New variable value", "value-first-on-R0");
  added.refresh(file("R1"));
  added.type("New variable name", "NEW");
  added.keep("New variable name");
  expect(added.stale()).toBe(true);
  // With no refresh in between, the change is made on the file shown and saves as it is.
  const current = editor(file("R0"));
  current.click("Edit A");
  current.type("New value for A", "on-R0");
  current.keep("New value for A");
  expect(current.text()).toContain("Review and save");
  expect(current.stale()).toBe(false);
});
