import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHostConfig, readHostConfig } from "../src/config";
import { readHostDiagnostics } from "../src/config/host-diagnostics";
import { createHostDiagnosticLog } from "../src/diagnostics/host-log";

const DEFAULTS = parseHostConfig({}).diagnostics;

/** config.yaml as written, with the diagnostics settings rig's log takes from it, or "defaults". */
const DOCUMENTS: readonly [string, string | "defaults"][] = [
  ["diagnostics:\n  level: debug\n  retention_days: 2\n", "debug/2"],
  ["{diagnostics: {level: error}}\n", "error/14"],
  ["? diagnostics\n: level: warn\n", "warn/14"],
  ["'diagnostics':\n  \"level\": debug\n", "debug/14"],
  // A quoted key spelled with an escape is the same key.
  ['"\\x64iagnostics":\n  level: debug\n', "debug/14"],
  ['"\\u0064iagnostics": {retention_days: 30}\n', "info/30"],
  ["%YAML 1.2\n---\ndiagnostics:\n  level: debug\n", "debug/14"],
  ["\uFEFFdiagnostics:\r\n  level: debug\r\n", "debug/14"],
  ["diagnostics:\n  level: debug\nalerts:\n  retired: true\n", "debug/14"],
  // A document readHostConfig refuses leaves the defaults, however valid its diagnostics section.
  ["diagnostics:\n  level: debug\nbogus: 1\n", "defaults"],
  [
    "diagnostics:\n  level: debug\ndeploy:\n  previews:\n    max: 0\n",
    "defaults",
  ],
  [
    "diagnostics:\n  level: debug\ndashboard:\n  domain: rig.example.com\n",
    "defaults",
  ],
  ["diagnostics:\n  level: loud\n", "defaults"],
  ["diagnostics:\n  retention_days: 0\n", "defaults"],
  ["diagnostics:\n", "defaults"],
  ["%YAML 1.1\n---\ndiagnostics:\n  level: debug\n", "defaults"],
  ["diagnostics:\n  level: debug\n---\n{}\n", "defaults"],
  ["diagnostics:\n  level: debug\ndiagnostics:\n  level: warn\n", "defaults"],
  ["diagnostics: &d\n  level: debug\n", "defaults"],
  ["diagnostics:\n  <<: {level: debug}\n", "defaults"],
  ["diagnostics: !!map\n  level: debug\n", "defaults"],
  ["diagnostics: [\n", "defaults"],
  // Text that cannot set the section, valid or not.
  ["", "defaults"],
  ["deploy:\n  production_branch: trunk\n", "defaults"],
  ["bogus: [\n", "defaults"],
  ["# diagnostics: {level: debug}\n", "defaults"],
  ['"diag\n  nostics":\n  level: debug\n', "defaults"],
];

const settings = (diagnostics: typeof DEFAULTS) =>
  `${diagnostics.level}/${diagnostics.retention_days}`;

test("rig's diagnostic log takes config.yaml's diagnostics section exactly where readHostConfig reads the document, and the defaults otherwise", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-host-diagnostics-"));
  try {
    const path = join(root, "config.yaml");
    for (const [document, expected] of DOCUMENTS) {
      await writeFile(path, document);
      const read = await readHostDiagnostics(root).then(
        (diagnostics) => diagnostics ?? DEFAULTS,
        () => DEFAULTS,
      );
      const whole = await readHostConfig(root).then(
        (host) => host.diagnostics,
        () => DEFAULTS,
      );
      expect({ document, read: settings(read) }).toEqual({
        document,
        read: settings(whole),
      });
      expect({ document, read: settings(read) }).toEqual({
        document,
        read: expected === "defaults" ? settings(DEFAULTS) : expected,
      });
    }
    // No config.yaml, or one that is not a file, leaves the defaults too.
    await rm(path);
    expect(await readHostDiagnostics(root)).toBeUndefined();
    await mkdir(path);
    expect(
      await readHostDiagnostics(root).catch((error: unknown) => error),
    ).toMatchObject({
      code: "read_failed",
      message: "Unable to read config document.",
      context: { path },
      hint: `Make ${path} a file you can read, then retry.`,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the diagnostic log rig opens keeps the level and the days config.yaml asks for, and the defaults when the document is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-host-diagnostics-"));
  try {
    const directory = join(root, "logs", "rig");
    const run = async (document: string) => {
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      for (const day of ["2026-08-20", "2026-09-07", "2026-09-09"])
        await writeFile(join(directory, `rig-${day}.jsonl`), "{}\n");
      await writeFile(join(root, "config.yaml"), document);
      const log = createHostDiagnosticLog({
        root,
        source: "rig",
        now: () => new Date("2026-09-10T12:00:00Z"),
      });
      for (const level of ["debug", "info", "warn"] as const)
        await log.record({ event: `probe.${level}`, level });
      return {
        written: (await readFile(join(directory, "rig.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => (JSON.parse(line) as { event: string }).event),
        kept: (await readdir(directory))
          .filter((name) => /-\d{4}-\d\d-\d\d\.jsonl$/.test(name))
          .sort(),
      };
    };
    expect(
      await run("diagnostics:\n  level: warn\n  retention_days: 2\n"),
    ).toEqual({ written: ["probe.warn"], kept: ["rig-2026-09-09.jsonl"] });
    expect(
      await run("diagnostics:\n  level: warn\n  retention_days: 2\nbogus: 1\n"),
    ).toEqual({
      written: ["probe.info", "probe.warn"],
      kept: ["rig-2026-09-07.jsonl", "rig-2026-09-09.jsonl"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
