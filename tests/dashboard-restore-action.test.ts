import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { RuntimeCommand } from "../src/daemon/protocol";
import * as daemon from "../web/server/daemon";

/** The dashboard's Restore through its Server Actions (ADR 0017): the server, not the dialog, decides whether what was typed
 * confirms the restore, and the generic command action refuses a restore outright. Next's request headers and rigd's
 * control plane are stood in for; admission is the real one, for a request from this Mac. */

const PORT = "48173";
/** Headers a dashboard page on this Mac sends with a Server Action. */
let requestHeaders = new Headers({
  host: `127.0.0.1:${PORT}`,
  origin: `http://127.0.0.1:${PORT}`,
  "sec-fetch-site": "same-origin",
});
mock.module("next/headers", () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({ get: () => undefined, set() {} }),
}));
/** Commands that reached rigd. The real module is taken before it is mocked: the mock is process-wide, so every other use
 * goes through to it. */
const real = { ...daemon };
const sent: RuntimeCommand[] = [];
let capturing = false;
mock.module("../web/server/daemon", () => ({
  ...real,
  async read(command: RuntimeCommand) {
    if (!capturing) return real.read(command as never);
    sent.push(command);
    return { outcome: "started", action: command.action };
  },
}));
const previousPort = process.env.PORT;
beforeAll(() => {
  // The site reads its port on first use; this file's actions are its first and only use in the process.
  process.env.PORT = PORT;
  capturing = true;
});
afterAll(() => {
  capturing = false;
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
});
const { runCommand, runRestore } = await import("../web/server/actions");

const restore = {
  action: "restore",
  project: "melody",
  target: "stable",
  job: "db-backup",
  backup: "20261011T030000Z",
  operationId: "op-1",
} as const;

test("a restore reaches rigd only through its own action, and only with the job's name typed", async () => {
  sent.length = 0;
  for (const typed of ["", "db-backu", "DB-BACKUP", "files-backup"])
    expect(await runRestore({ command: restore, typed })).toMatchObject({
      ok: false,
      failure: {
        code: "RESTORE_CONFIRMATION",
        hint: expect.stringContaining("Type db-backup"),
      },
    });
  expect(sent).toEqual([]);
  expect(
    await runRestore({ command: restore, typed: " db-backup " }),
  ).toMatchObject({ ok: true, value: { outcome: "started" } });
  expect(sent).toEqual([restore]);
});

test("the generic command action refuses a restore, typed confirmation or not", async () => {
  sent.length = 0;
  expect(await runCommand(restore)).toMatchObject({
    ok: false,
    failure: { code: "RESTORE_CONFIRMATION" },
  });
  expect(await runCommand({ ...restore, typed: "db-backup" })).toMatchObject({
    ok: false,
  });
  expect(sent).toEqual([]);
  // Any other command still goes through.
  expect(
    await runCommand({ action: "run", project: "melody", job: "db-backup" }),
  ).toMatchObject({ ok: true });
  expect(sent).toEqual([
    { action: "run", project: "melody", job: "db-backup" },
  ]);
});

test("the restore action refuses what is not one restore of a named backup, and a request admission refuses", async () => {
  sent.length = 0;
  for (const input of [
    undefined,
    { command: restore },
    { command: { ...restore, backup: "latest" }, typed: "db-backup" },
    { command: { ...restore, action: "run" }, typed: "db-backup" },
    { command: { ...restore, job: undefined }, typed: "" },
    { command: restore, typed: "db-backup", extra: true },
  ])
    expect(await runRestore(input)).toMatchObject({
      ok: false,
      failure: { code: "INVALID_REQUEST" },
    });
  // A page from another site cannot drive it, whatever it typed.
  const own = requestHeaders;
  requestHeaders = new Headers({
    host: `127.0.0.1:${PORT}`,
    origin: "https://elsewhere.example",
  });
  try {
    expect(
      await runRestore({ command: restore, typed: "db-backup" }),
    ).toMatchObject({ ok: false, failure: { code: "ORIGIN" } });
  } finally {
    requestHeaders = own;
  }
  expect(sent).toEqual([]);
});
