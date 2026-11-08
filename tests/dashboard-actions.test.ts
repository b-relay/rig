import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { basic, local } from "./support/dashboard-site";
import type { RuntimeCommand } from "../src/daemon/protocol";
import { RigError } from "../src/domain/errors";
import * as daemon from "../web/server/daemon";

/** The dashboard's DNS delete and record check, and its settling of an Operation whose reply was lost, through their Server Actions: what
 * reaches rigd, and what the browser is answered. Next's request headers and rigd's control plane are stood in for;
 * admission is the real one, for a signed-in browser on this Mac. tests/dashboard-env-revisions.test.ts drives the config
 * and env actions against a real control plane. */

let requestHeaders = new Headers({ ...local(), authorization: basic() });
mock.module("next/headers", () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({ get: () => undefined, set() {} }),
}));
/** Commands that reached rigd, and how rigd answers each. The real module is taken before it is mocked: the mock is
 * process-wide, so every other use goes through to it. */
const real = { ...daemon };
const sent: RuntimeCommand[] = [];
let answer: (command: RuntimeCommand) => unknown = () => ({});
let capturing = false;
mock.module("../web/server/daemon", () => ({
  ...real,
  async read(command: RuntimeCommand) {
    if (!capturing) return real.read(command as never);
    sent.push(command);
    return answer(command);
  },
}));
beforeAll(() => {
  capturing = true;
});
afterAll(() => {
  capturing = false;
});
const { checkDnsRecord, runCommand, runDnsDelete, settleOperation } =
  await import("../web/server/actions");

/** Runs `act` with requests from a page on another site. */
async function fromElsewhere<T>(act: () => Promise<T>): Promise<T> {
  const own = requestHeaders;
  requestHeaders = new Headers({
    ...local(),
    authorization: basic(),
    origin: "https://elsewhere.example",
  });
  try {
    return await act();
  } finally {
    requestHeaders = own;
  }
}

const remove = {
  action: "dns-delete",
  dns: {
    zone: "example.com",
    id: "a1",
    modifiedOn: "2026-10-01T00:00:00Z",
    confirm: "app.example.com",
  },
} as const;

test("a DNS delete reaches rigd once, as the page read the record and with the name typed, and rigd's answer comes back", async () => {
  sent.length = 0;
  answer = () => ({ deleted: "app.example.com" });
  expect(await runDnsDelete(remove)).toEqual({
    ok: true,
    value: { deleted: "app.example.com" },
  });
  expect(sent).toEqual([remove]);

  sent.length = 0;
  answer = () => {
    throw new RigError(
      "DNS_CONFIRMATION",
      "The name typed is not the record's.",
      "Type app.example.com.",
    );
  };
  expect(await runDnsDelete(remove)).toEqual({
    ok: false,
    failure: {
      code: "DNS_CONFIRMATION",
      message: "The name typed is not the record's.",
      hint: "Type app.example.com.",
    },
  });
  expect(sent).toEqual([remove]);
});

test("a DNS delete without its typed name, not a delete, or from another site never reaches rigd", async () => {
  sent.length = 0;
  for (const [input, code] of [
    [{ ...remove, dns: { ...remove.dns, confirm: "  " } }, "DNS_CONFIRMATION"],
    [
      { ...remove, dns: { ...remove.dns, modifiedOn: undefined } },
      "DNS_CONFIRMATION",
    ],
    [{ ...remove, action: "dns-update" }, "INVALID_REQUEST"],
    [undefined, "INVALID_REQUEST"],
  ] as const)
    expect(await runDnsDelete(input)).toMatchObject({
      ok: false,
      failure: { code },
    });
  // The generic command action never deletes a record, typed name or not.
  expect(await runCommand(remove)).toMatchObject({
    ok: false,
    failure: { code: "DNS_CONFIRMATION" },
  });
  expect(await fromElsewhere(() => runDnsDelete(remove))).toMatchObject({
    ok: false,
    failure: { code: "ORIGIN" },
  });
  expect(sent).toEqual([]);
});

test("the record dialog's draft is checked on the server against rigd's record rules, and reaches no rigd", async () => {
  sent.length = 0;
  const draft = {
    type: "A",
    name: "app",
    content: "203.0.113.5",
    ttl: 300,
    proxied: true,
    priority: "10",
    comment: "",
  };
  expect(await checkDnsRecord({ zone: "example.com", draft })).toEqual({
    ok: true,
    value: {
      ok: true,
      record: {
        name: "app.example.com",
        type: "A",
        content: "203.0.113.5",
        ttl: 300,
        proxied: true,
      },
    },
  });
  expect(
    await checkDnsRecord({
      zone: "example.com",
      draft: { ...draft, content: "1.2.3" },
    }),
  ).toEqual({
    ok: true,
    value: {
      ok: false,
      issues: { content: "It must be an IPv4 address such as 100.64.0.1." },
    },
  });
  for (const input of [
    undefined,
    { zone: "example.com" },
    { zone: "example.com", draft: { ...draft, ttl: "300" } },
    { zone: "example.com", draft: { ...draft, type: "NS" } },
  ])
    expect(await checkDnsRecord(input)).toMatchObject({
      ok: false,
      failure: { code: "INVALID_REQUEST" },
    });
  expect(
    await fromElsewhere(() => checkDnsRecord({ zone: "example.com", draft })),
  ).toMatchObject({ ok: false, failure: { code: "ORIGIN" } });
  expect(sent).toEqual([]);
});

/** rigd as it stands on Operation `op-1`: where the queue has it, and what Activity recorded. */
function rigd(
  position: "running" | "waiting" | undefined,
  records: {
    id: string;
    outcome: string;
    occurredAt: string;
    message?: string;
  }[],
) {
  sent.length = 0;
  answer = (command) =>
    command.action === "queue"
      ? {
          waiting: 0,
          ...(position
            ? { operation: { id: command.operation, state: position } }
            : {}),
        }
      : { operations: records };
}
const reads = () => sent.map((command) => command.action);

test("an Operation still running settles as running without reading Activity, and one still queued as waiting", async () => {
  rigd("running", []);
  expect(await settleOperation("op-1")).toEqual({
    ok: true,
    value: { state: "running" },
  });
  expect(sent).toEqual([{ action: "queue", operation: "op-1" }]);

  rigd("waiting", []);
  expect(await settleOperation("op-1")).toEqual({
    ok: true,
    value: { state: "waiting" },
  });
  expect(sent).toEqual([
    { action: "queue", operation: "op-1" },
    { action: "activity", operation: "op-1" },
  ]);
});

test("a finished Operation settles with the outcome Activity last recorded for it, and one rigd does not know as unknown", async () => {
  rigd(undefined, [
    { id: "op-1", outcome: "started", occurredAt: "2026-11-07T10:00:00Z" },
    { id: "op-2", outcome: "failed", occurredAt: "2026-11-07T10:00:01Z" },
    {
      id: "op-1",
      outcome: "failed",
      occurredAt: "2026-11-07T10:00:02Z",
      message: "web did not become ready.",
    },
  ]);
  expect(await settleOperation("op-1")).toEqual({
    ok: true,
    value: {
      state: "finished",
      outcome: "failed",
      occurredAt: "2026-11-07T10:00:02Z",
      message: "web did not become ready.",
    },
  });
  expect(reads()).toEqual(["queue", "activity"]);

  rigd(undefined, [
    { id: "op-1", outcome: "succeeded", occurredAt: "2026-11-07T10:00:03Z" },
  ]);
  expect(await settleOperation("op-1")).toEqual({
    ok: true,
    value: {
      state: "finished",
      outcome: "succeeded",
      occurredAt: "2026-11-07T10:00:03Z",
    },
  });

  rigd(undefined, [
    { id: "op-2", outcome: "succeeded", occurredAt: "2026-11-07T10:00:04Z" },
  ]);
  expect(await settleOperation("op-1")).toEqual({
    ok: true,
    value: { state: "unknown" },
  });
});

test("settling answers rigd's refusal as a failure, and asks rigd nothing for no id or from another site", async () => {
  sent.length = 0;
  answer = () => {
    throw new RigError(
      "DAEMON_UNAVAILABLE",
      "rigd is not running.",
      "Start it with rigd start.",
    );
  };
  expect(await settleOperation("op-1")).toEqual({
    ok: false,
    failure: {
      code: "DAEMON_UNAVAILABLE",
      message: "rigd is not running.",
      hint: "Start it with rigd start.",
    },
  });
  expect(reads()).toEqual(["queue"]);

  sent.length = 0;
  for (const id of ["", undefined, 7])
    expect(await settleOperation(id as never)).toMatchObject({
      ok: false,
      failure: { code: "INVALID_REQUEST" },
    });
  expect(await fromElsewhere(() => settleOperation("op-1"))).toMatchObject({
    ok: false,
    failure: { code: "ORIGIN" },
  });
  expect(sent).toEqual([]);
});
