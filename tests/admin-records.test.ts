import { expect, test } from "bun:test";
import { installationRecord } from "../src/daemon/admin-records";

test("an installation record keeps its fields in their written order and leaves out an absent bun or proxy", () => {
  const command = ["/rig/bin/rigd", "serve"];
  const record = installationRecord({
    mode: "launchd",
    command,
    version: "1.1.0+dev",
    bun: "/usr/local/bin/bun",
    proxy: "managed",
  });
  expect(JSON.stringify(record)).toBe(
    '{"mode":"launchd","command":["/rig/bin/rigd","serve"],"version":"1.1.0+dev","bun":"/usr/local/bin/bun","proxy":"managed"}',
  );
  expect(record.command).not.toBe(command);
  expect(
    JSON.stringify(
      installationRecord({
        mode: "process",
        command: [],
        version: "v",
        bun: "",
        proxy: undefined,
      }),
    ),
  ).toBe('{"mode":"process","command":[],"version":"v"}');
});
