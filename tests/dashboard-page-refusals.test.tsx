import { afterEach, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { basic, local } from "./support/dashboard-site";
import type { RuntimeCommand } from "../src/daemon/protocol";
import { RigError } from "../src/domain/errors";
import * as daemon from "../web/server/daemon";

/** What a Project or Target page shows when rigd refuses the read it is built on, and the editor's own invariant. rigd is
 * stood in for. */

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
afterEach(() => {
  answer = undefined;
});
const { project } = await import("../web/server/project");
const { target } = await import("../web/server/target");
const { settled } = await import("../web/server/settled");
const { default: ProjectLayout } =
  await import("../web/app/projects/[name]/(sections)/layout");
const { default: TargetLayout } =
  await import("../web/app/projects/[name]/targets/[target]/layout");
const { useDraft } = await import("../web/components/config-editor");

const DOWN = new RigError(
  "DAEMON_TIMEOUT",
  "rigd did not answer the list within 5 s; it may be busy (operation op-7).",
  "Run rig activity to see what rigd is doing, then retry; reads are answered without queueing.",
  {
    operationId: "op-7",
    issues: [{ path: ["services", "web", "command"], message: "is required" }],
  },
);
const LISTED = {
  projects: [{ name: "pantry", repoPath: "/repo/pantry" }],
};

test("a list rigd refused is thrown as a RigError carrying rigd's code, message, hint and details", async () => {
  answer = () => {
    throw DOWN;
  };
  const params = Promise.resolve({ name: "pantry" });
  const thrown = await project(params).catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(RigError);
  expect(thrown).toMatchObject({
    code: "DAEMON_TIMEOUT",
    message: DOWN.message,
    hint: DOWN.hint,
    details: {
      operationId: "op-7",
      issues: [
        { path: ["services", "web", "command"], message: "is required" },
      ],
    },
  });
  // The layout's read keeps every part of it, field problems included.
  expect(await settled(project(params))).toEqual({
    ok: false,
    failure: {
      code: "DAEMON_TIMEOUT",
      message: DOWN.message,
      hint: DOWN.hint,
      operationId: "op-7",
      issues: [{ path: "services.web.command", message: "is required" }],
    },
  });
});

test("a Project page whose list rigd refused shows the code, message, hint and Operation", async () => {
  answer = () => {
    throw DOWN;
  };
  const html = renderToStaticMarkup(
    await ProjectLayout({
      params: Promise.resolve({ name: "pantry" }),
      children: "SECTION",
      chip: null,
    }),
  );
  expect(html).toContain("DAEMON_TIMEOUT");
  expect(html).toContain("it may be busy (operation op-7).");
  expect(html).toContain("Run rig activity to see what rigd is doing");
  expect(html).toContain("/activity?operation=op-7");
  expect(html).not.toContain("SECTION");
});

test("a Target page whose status rigd refused shows rigd's refusal, and a refusal without a hint gets one", async () => {
  answer = (command) => {
    if (command.action === "list") return LISTED;
    throw new RigError(
      "STATE_CORRUPT",
      "The registry could not be read.",
      "Run rig doctor.",
    );
  };
  const params = Promise.resolve({ name: "pantry", target: "stable" });
  const html = renderToStaticMarkup(
    await TargetLayout({ params, children: "SECTION" }),
  );
  expect(html).toContain("STATE_CORRUPT");
  expect(html).toContain("The registry could not be read.");
  expect(html).toContain("Run rig doctor.");
  expect(html).not.toContain("SECTION");
  // A failure that came without a hint, such as a plain error, is thrown with one that says where to look.
  answer = (command) => {
    if (command.action === "list") return LISTED;
    throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
  };
  expect(await target(params).catch((error: unknown) => error)).toMatchObject({
    _tag: "RigError",
    code: "ECONNRESET",
    message: "socket closed",
    hint: "Run 'rigd status' to inspect the daemon.",
    details: {},
  });
});

test("a config control rendered outside the editor is a bug in Rig, said so", () => {
  function Stray() {
    useDraft();
    return null;
  }
  expect(() => renderToStaticMarkup(<Stray />)).toThrow(
    expect.objectContaining({
      _tag: "RigError",
      code: "INTERNAL_INVARIANT",
      message: "Config controls render inside the editor.",
      hint: "This is a bug in Rig; report it with this message.",
      details: { context: "DraftContext" },
    }),
  );
});
