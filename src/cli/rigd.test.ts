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
  };
  for (const command of [[], ["install"], ["status"], ["uninstall"]])
    for (const flag of ["--help", "-h"])
      expect(await runRigdCli([...command, flag], options)).toBe(0);
  expect(calls).toBe(0);
  text = "";
  expect(await runRigdCli(["status"], options)).toBe(0);
  expect(text).toBe("Installed  yes\nRunning    no\nReachable  no\n");
  expect(text).not.toContain("/secret");
  text = "";
  expect(await runRigdCli(["install"], options)).toBe(0);
  expect(text).toBe("rigd installed\n");
  expect(await runRigdCli(["--log-level", "debug"], options)).toBe(1);
});
