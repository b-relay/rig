import { afterAll, expect, mock, test } from "bun:test";
import {
  elements,
  hasLabel,
  labelled,
  mountWithoutDom,
  textOf,
} from "./support/hook-harness";
import * as actions from "../web/server/actions";
import type { EnvFileView } from "../web/lib/types";

/** The value rigd answers a reveal with, while a test sets it. The real module is taken before it is mocked: the mock is
 * process-wide, so every other use goes through to it. */
const real = { ...actions };
let revealing: string | undefined;
let saving = false;
mock.module("../web/server/actions", () => ({
  ...real,
  async runEnvEdit(input: unknown) {
    if (saving) return { ok: true, value: {} };
    if (revealing === undefined) return real.runEnvEdit(input);
    return { ok: true, value: { value: revealing, revision: "R0" } };
  },
}));
afterAll(() => {
  revealing = undefined;
});
const { SecretsEditor } = await import("../web/components/secrets-editor");

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

/** Offers `text` to the field labelled `label` by paste or drop, as a browser does; whether the browser may go on and put it
 * in the field. */
function offer(
  page: ReturnType<typeof editor>,
  label: string,
  how: "onPaste" | "onDrop",
  text: string,
): boolean {
  let refused = false;
  const data = { getData: () => text };
  page.mounted.act(() =>
    (labelled(page.mounted.tree, label).props[how] as (event: unknown) => void)(
      {
        clipboardData: data,
        dataTransfer: data,
        preventDefault() {
          refused = true;
        },
      },
    ),
  );
  return !refused;
}
/** What the page says of a value it cannot hold; the Failure element carries it as a prop. */
const failureOf = (page: ReturnType<typeof editor>) =>
  JSON.stringify(
    elements(page.mounted.tree).find((each) => each.props.failure)?.props
      .failure ?? null,
  );

test.each([
  ["New value for A", "onPaste", "held\nback"],
  ["New value for A", "onDrop", "held\r\nback"],
  ["New variable value", "onPaste", "held\rback"],
  ["New variable value", "onDrop", "held\nback"],
] as const)(
  "%s refuses text with a line break through %s, and says so, since a one-line field would strip it; text without one goes in",
  (label, how, text) => {
    const page = editor(file("R0"));
    if (label === "New value for A") page.click("Edit A");
    expect(offer(page, label, how, "one line")).toBe(true);
    expect(failureOf(page)).toBe("null");
    expect(offer(page, label, how, text)).toBe(false);
    expect(failureOf(page)).toContain("has line breaks");
    expect(failureOf(page)).toContain("/rig/env/demo/all.env");
    // Neither the field nor the words on the page hold any of it.
    expect(failureOf(page)).not.toContain("held");
    expect(labelled(page.mounted.tree, label).props.value).toBe("");
  },
);

test("a revealed value with line breaks does not open in the one-line field, and the page says so; one without opens as it is", async () => {
  const reveal = async (page: ReturnType<typeof editor>, key: string) => {
    page.click(`Reveal ${key}`);
    // The reply comes through a few promises; no timer is involved.
    for (let tick = 0; !hasLabel(page.mounted.tree, `Hide ${key}`); tick++) {
      if (tick === 100) throw new Error(`${key} was not revealed.`);
      await Promise.resolve();
      page.mounted.render();
    }
  };
  revealing = "held\nback";
  const page = editor(file("R0"));
  await reveal(page, "A");
  page.click("Edit A");
  expect(hasLabel(page.mounted.tree, "New value for A")).toBe(false);
  expect(failureOf(page)).toContain("has line breaks");
  expect(failureOf(page)).toContain("/rig/env/demo/all.env");
  expect(failureOf(page)).not.toContain("held");
  // Masked again it can be replaced whole, as any value the page does not show.
  page.click("Hide A");
  page.click("Edit A");
  expect(labelled(page.mounted.tree, "New value for A").props.value).toBe("");

  revealing = "one line";
  const plain = editor(file("R0"));
  await reveal(plain, "A");
  plain.click("Edit A");
  expect(labelled(plain.mounted.tree, "New value for A").props.value).toBe(
    "one line",
  );
});

test.each([
  ["1BAD", "does not start with a digit"],
  ["_RIG_X", "does not start with a digit or _RIG_"],
  ["BAD-NAME", "letters, digits and underscores"],
  ["A", "A is already in this file"],
])(
  "a new name %s that cannot be added says why in text, since a disabled button takes no hover or focus",
  (name, why) => {
    const page = editor(file("R0"));
    const add = () =>
      elements(page.mounted.tree).find(
        (each) => each.props.type === "submit" && textOf(each).includes("Add"),
      )!;
    page.type("New variable name", name);
    expect(page.text()).toContain(why);
    expect(add().props.disabled).toBe(true);
    expect(
      labelled(page.mounted.tree, "New variable name").props["aria-invalid"],
    ).toBe(true);
    // A valid name, or none yet, has nothing to explain.
    page.type("New variable name", "GOOD_NAME");
    expect(page.text()).not.toContain(why);
    expect(add().props.disabled).toBe(false);
    page.type("New variable name", "");
    expect(page.text()).not.toContain(why);
  },
);

test("each save has restart controls of its own: a refresh keeps them, and a restart before a later save never answers for it", async () => {
  saving = true;
  try {
    const mounted = mountWithoutDom(SecretsEditor);
    const readers = [
      { name: "stable", kind: "stable" as const, state: "running" as const },
    ];
    const shown = (next: EnvFileView) =>
      mounted.render({ project: "demo", file: next, readers });
    shown(file("R0"));
    const byText = (text: string) =>
      elements(mounted.tree).find(
        (each) => textOf(each) === text && each.props.onClick,
      )!;
    const save = async (name: string, revision: string) => {
      mounted.act(() =>
        (
          labelled(mounted.tree, "New variable name").props.onChange as (
            event: unknown,
          ) => void
        )({ target: { value: name } }),
      );
      const form = elements(mounted.tree).find(
        (each) =>
          each.type === "form" &&
          elements(each.props.children).some(
            (child) => child.props["aria-label"] === "New variable name",
          ),
      )!;
      mounted.act(() =>
        (form.props.onSubmit as (event: unknown) => void)({
          preventDefault() {},
        }),
      );
      mounted.act(byText("Review and save").props.onClick as () => void);
      mounted.act(byText("Save").props.onClick as () => void);
      // The reply comes through a few promises; no timer is involved.
      for (
        let tick = 0;
        !textOf(mounted.tree).includes(`${name} was written`);
        tick++
      ) {
        if (tick === 100) throw new Error(`${name} was not saved.`);
        await Promise.resolve();
        mounted.render();
      }
      shown(file(revision, ["A", "B", name]));
    };
    const controls = () =>
      elements(mounted.tree).find(
        (each) => "readers" in each.props,
      ) as unknown as {
        key: string | null;
      };
    await save("FIRST", "R1");
    const first = controls().key;
    expect(first).not.toBeNull();
    // An automatic refresh leaves the same controls mounted, so a restart they did stays said.
    shown(file("R1", ["A", "B", "FIRST"]));
    expect(controls().key).toBe(first);
    await save("SECOND", "R2");
    expect(textOf(mounted.tree)).toContain("SECOND was written");
    // A new key mounts new controls: enabled again, with nothing to say of the restart before this write.
    expect(controls().key).not.toBe(first);
  } finally {
    saving = false;
  }
});
