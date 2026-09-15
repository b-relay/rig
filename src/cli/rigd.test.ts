import { expect, test } from "bun:test";
import { runRigdCli } from "./rigd";

test("daemon administration uses observed state and never reveals private paths", async () => {
  let text = "";
  let calls = 0;
  const options = {
    admin: {
      async install() {
        calls++;
        return {
          installed: true,
          running: true,
          reachable: true,
          tokenPath: "/secret",
        };
      },
      async status() {
        calls++;
        return {
          installed: true,
          running: false,
          reachable: false,
          tokenPath: "/secret",
        };
      },
      async uninstall() {
        calls++;
        return { installed: false };
      },
    },
    output: {
      write(value: string) {
        text += value;
      },
      error(value: string) {
        text += value;
      },
    },
    diagnostics: {
      async record() {
        return {};
      },
    },
    newOperationId: () => "admin-op",
    capture: async () => {
      calls++;
      return 0;
    },
  };
  for (const command of [[], ["install"], ["status"], ["uninstall"], ["capture"]])
    for (const flag of ["--help", "-h"]) {
      text = "";
      expect(await runRigdCli([...command, flag], options)).toBe(0);
      expect(text).toContain(`Usage: rigd${command.length ? ` ${command[0]}` : ""}`);
    }
  expect(calls).toBe(0);
  text = "";
  expect(await runRigdCli(["status"], options)).toBe(1);
  expect(text).toBe(
    "Installed  yes\nRunning    no\nReachable  no\nrigd is installed but not running. Run rigd install to start it.\n",
  );
  expect(text).not.toContain("/secret");
  text = "";
  expect(await runRigdCli(["install"], options)).toBe(0);
  expect(text).toBe("rigd installed\n");
  expect(await runRigdCli(["--log-level", "debug"], options)).toBe(1);
});

test("rigd --version prints the version without touching the daemon", async () => {
  const { RIG_VERSION } = await import("../domain/version");
  let text = "";
  let calls = 0;
  const count = async () => {
    calls++;
    return {};
  };
  const code = await runRigdCli(["--version"], {
    admin: { install: count, status: count, uninstall: count },
    output: { write: (value: string) => void (text += value), error: (value: string) => void (text += value) },
    diagnostics: { async record() { return {}; } },
    newOperationId: () => "version",
    capture: async () => {
      calls++;
      return 0;
    },
  });
  expect(code).toBe(0);
  expect(text.trim()).toBe(RIG_VERSION);
  expect(calls).toBe(0);
});

test("rigd capture is a documented command that needs its request file and returns the wrapper's exit code", async () => {
  let text = "";
  const captured: string[] = [];
  const options = {
    admin: {
      async install() {
        return {};
      },
      async status() {
        return { installed: true, running: true, reachable: true };
      },
      async uninstall() {
        return {};
      },
    },
    output: {
      write(value: string) {
        text += value;
      },
      error(value: string) {
        text += value;
      },
    },
    diagnostics: {
      async record() {
        return {};
      },
    },
    newOperationId: () => "admin-op",
    capture: async (requestFile: string) => {
      captured.push(requestFile);
      return 3;
    },
  };
  expect(await runRigdCli(["--help"], options)).toBe(0);
  expect(text).toContain("capture");
  text = "";
  expect(await runRigdCli(["capture"], options)).toBe(1);
  expect(text).toContain("missing required argument 'request-file'");
  expect(text).toContain("Run rigd capture --help.");
  expect(captured).toEqual([]);
  expect(await runRigdCli(["capture", "/tmp/request.json"], options)).toBe(3);
  expect(captured).toEqual(["/tmp/request.json"]);
  text = "";
  expect(await runRigdCli(["status"], options)).toBe(0);
  expect(text).toBe("Installed  yes\nRunning    yes\nReachable  yes\n");
});
