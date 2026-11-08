import { expect, test } from "bun:test";
import { createRigCommand } from "./commands";
import { namesRead, requestsJson } from "./structured-reads";

const command = createRigCommand(
  "/workspace",
  { write() {}, error() {} },
  async () => {},
);

test("the reads are named by their command path, whatever flags sit among the words", () => {
  for (const args of [
    ["list"],
    ["status", "stable", "--json"],
    ["doctor"],
    ["logs", "--follow", "stable"],
    ["monitor", "--since", "1h"],
    ["proxy"],
    ["proxy", "verify"],
    ["dns", "list"],
    ["backup", "list"],
    ["list", "--bogus"],
  ])
    expect({ args, read: namesRead(command, args) }).toEqual({
      args,
      read: true,
    });
  for (const args of [
    ["up", "stable"],
    ["proxy", "--json", "reload"],
    ["backup", "restore", "db-backup", "latest"],
    ["dns", "set"],
    ["--", "list"],
    [],
  ])
    expect({ args, read: namesRead(command, args) }).toEqual({
      args,
      read: false,
    });
});

test("--json is asked for only before a -- separator", () => {
  expect(requestsJson(["list", "--json"])).toBe(true);
  expect(requestsJson(["list"])).toBe(false);
  expect(requestsJson(["logs", "--", "--json"])).toBe(false);
});
