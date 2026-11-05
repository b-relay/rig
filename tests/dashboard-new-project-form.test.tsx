import { afterAll, expect, mock, test } from "bun:test";
import { basic, local } from "./support/dashboard-site";
import { elements, mountWithoutDom, textOf } from "./support/hook-harness";
import type { RuntimeCommand } from "../src/daemon/protocol";
import * as daemon from "../web/server/daemon";
import { NewProjectForm } from "../web/components/new-project-form";

/** Add Project, driven as an operator would, over the real Server Action and admission, with rigd stood in for: an
 * inspection speaks only for the path it read. */

mock.module("next/headers", () => ({
  headers: async () => new Headers({ ...local(), authorization: basic() }),
  cookies: async () => ({ get: () => undefined, set() {} }),
}));
const real = { ...daemon };
let answer: ((command: RuntimeCommand) => unknown) | undefined;
mock.module("../web/server/daemon", () => ({
  ...real,
  async read(command: RuntimeCommand) {
    return answer ? answer(command) : real.read(command as never);
  },
}));
afterAll(() => {
  answer = undefined;
});

const info = (name: string, existing: boolean) => ({
  name,
  existing,
  productionBranch: "main",
  currentBranch: "main",
  gitRequired: false,
});
function form() {
  const mounted = mountWithoutDom(NewProjectForm);
  mounted.render({});
  const type = (id: string, value: string) => {
    const field = elements(mounted.tree).find((each) => each.props.id === id)!;
    mounted.act(() =>
      (field.props.onChange as (event: { target: { value: string } }) => void)({
        target: { value },
      }),
    );
  };
  const inspect = () => {
    const search = elements(mounted.tree).find(
      (each) =>
        each.type === "form" &&
        elements(each.props.children).some(
          (child) => child.props.id === "repo-path",
        ),
    )!;
    mounted.act(() =>
      (search.props.onSubmit as (event: unknown) => void)({
        preventDefault() {},
      }),
    );
  };
  /** Gives the event loop turns until `ended`; no clock is waited on. */
  const until = async (ended: () => boolean) => {
    for (let turn = 0; turn < 1000 && !ended(); turn++) {
      await new Promise((resolve) => setImmediate(resolve));
      mounted.render();
    }
    expect(ended()).toBe(true);
  };
  const registerOffered = () =>
    textOf(mounted.tree).includes("Register Project");
  const name = () =>
    elements(mounted.tree).find((each) => each.props.id === "project-name")
      ?.props.value;
  return { mounted, type, inspect, until, registerOffered, name };
}

test("changing an inspected path takes its form away, to an existing repository or a fresh one, until that path is inspected", async () => {
  answer = (command) =>
    command.repoPath === "/code/quill"
      ? info("quill", true)
      : command.repoPath === "/code/pantry"
        ? info("pantry", true)
        : info("fresh", false);
  const page = form();
  page.type("repo-path", "/code/quill");
  expect(page.registerOffered()).toBe(false);
  page.inspect();
  await page.until(page.registerOffered);
  expect(page.name()).toBe("quill");
  expect(textOf(page.mounted.tree)).toContain("already has a rig.yaml");

  // Existing to existing: nothing of quill stands beside pantry's path.
  page.type("repo-path", "/code/pantry");
  expect(page.registerOffered()).toBe(false);
  expect(textOf(page.mounted.tree)).not.toContain("already has a rig.yaml");
  page.inspect();
  await page.until(page.registerOffered);
  expect(page.name()).toBe("pantry");

  // Existing to fresh: its own form, named for itself.
  page.type("repo-path", "/code/fresh");
  expect(page.registerOffered()).toBe(false);
  page.inspect();
  await page.until(page.registerOffered);
  expect(page.name()).toBe("fresh");
  expect(textOf(page.mounted.tree)).not.toContain("already has a rig.yaml");
});

test("a reply for a path since changed populates nothing, and a refused inspection of an earlier path is not shown against the new one", async () => {
  let reply: ((value: unknown) => void) | undefined;
  answer = () => new Promise((resolve) => (reply = resolve));
  const page = form();
  page.type("repo-path", "/code/quill");
  page.inspect();
  await page.until(() => reply !== undefined);
  page.type("repo-path", "/code/pantry");
  reply!(info("quill", true));
  // The inspection ended: Inspect is offered again, and only then can its reply have been taken.
  await page.until(
    () =>
      elements(page.mounted.tree).find(
        (each) =>
          each.props.type === "submit" && textOf(each).includes("Inspect"),
      )?.props.disabled === false,
  );
  expect(page.registerOffered()).toBe(false);
  expect(page.name()).toBeUndefined();

  answer = () => {
    throw Object.assign(new Error("Not a directory."), {
      code: "PATH_MISSING",
      hint: "Check the path.",
    });
  };
  page.inspect();
  const refusal = () =>
    elements(page.mounted.tree).find((each) => each.props.failure)?.props
      .failure;
  await page.until(() => refusal() !== undefined);
  page.type("repo-path", "/code/other");
  expect(refusal()).toBeUndefined();
});

test("a fresh inspection does not carry a Git choice made for the path before it", async () => {
  answer = () => ({ ...info("fresh", false), gitRequired: true });
  const page = form();
  page.type("repo-path", "/code/one");
  page.inspect();
  await page.until(page.registerOffered);
  const checkbox = () =>
    elements(page.mounted.tree).find(
      (each) => "onCheckedChange" in each.props,
    )!;
  page.mounted.act(() =>
    (checkbox().props.onCheckedChange as (next: boolean) => void)(true),
  );
  expect(checkbox().props.checked).toBe(true);
  page.type("repo-path", "/code/two");
  page.inspect();
  await page.until(page.registerOffered);
  expect(checkbox().props.checked).toBe(false);
});
