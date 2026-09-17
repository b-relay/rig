import { expect, test } from "bun:test";
import { composeEnvironment } from "../src/domain/process-environment";
import { executionBaseline } from "../src/daemon/environment";
import { RigError } from "../src/domain/errors";

const leaf = { name: "DB", source: "env.DB", value: "app" };

test("later sources win, and overrides name every source of a file-supplied name without its value", () => {
  const composed = composeEnvironment({
    baseline: { PATH: "/bin", DB: "baseline" },
    publicEnv: { DB: "app", ONLY_PUBLIC: "1" },
    files: [
      { path: "/a.env", values: { TOKEN: "one", DB: "app" } },
      { path: "/b.env", values: { TOKEN: "two", ONLY_FILE: "x" } },
    ],
    guarded: [leaf],
  });
  expect(composed.env).toEqual({
    PATH: "/bin",
    DB: "app",
    ONLY_PUBLIC: "1",
    TOKEN: "two",
    ONLY_FILE: "x",
  });
  expect(composed.overrides).toEqual([
    { key: "DB", sources: ["env", "/a.env"] },
    { key: "TOKEN", sources: ["/a.env", "/b.env"] },
  ]);
});

test("only the final file value of a guarded leaf decides a conflict, and an equal string under another name is not provenance", () => {
  const compose = (files: { path: string; values: Record<string, string> }[]) =>
    composeEnvironment({
      baseline: {},
      publicEnv: { DB: "app", OTHER: "app" },
      files,
      guarded: [leaf],
    });
  // A lower file disagrees but a higher file restores the public value.
  expect(
    compose([
      { path: "/a.env", values: { DB: "other" } },
      { path: "/b.env", values: { DB: "app" } },
    ]).env.DB,
  ).toBe("app");
  // OTHER holds the same string as the guarded leaf; nothing was built from it, so a file may change it.
  expect(
    compose([{ path: "/a.env", values: { OTHER: "changed" } }]).env,
  ).toEqual({ DB: "app", OTHER: "changed" });
  const failure = (() => {
    try {
      compose([
        { path: "/a.env", values: { DB: "app" } },
        { path: "/b.env", values: { DB: "hidden" } },
      ]);
    } catch (error) {
      return error as RigError;
    }
  })();
  expect(failure).toMatchObject({
    code: "ENV_CONFLICT",
    details: { key: "DB", sources: ["env.DB", "/b.env"] },
  });
  expect(JSON.stringify([failure!.message, failure!.hint])).not.toContain(
    "hidden",
  );
});

test("the execution baseline carries the operator's PATH, HOME, locale and zone, and nothing else of the daemon's environment", () => {
  expect(
    executionBaseline({
      PATH: "/bin",
      HOME: "/home/op",
      LANG: "en_US.UTF-8",
      TZ: "UTC",
      USER: "op",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp/daemon",
      RIG_ROOT: "/rig",
      RIG_DAEMON_CHILD: "1",
      GITHUB_TOKEN: "t",
    }),
  ).toEqual({ PATH: "/bin", HOME: "/home/op", LANG: "en_US.UTF-8", TZ: "UTC" });
});
