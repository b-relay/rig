import { test, expect } from "bun:test";
import { createRigdApi, RigdError } from "../web/dashboard/api";
import { routeUrl, targetSelector } from "../web/dashboard/target";
import { sessionSnapshots } from "../web/dashboard/hooks";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

test("a command is posted to the relay as JSON with an operation id and no credential, and answers its result", async () => {
  const sent: { path: string; init?: RequestInit }[] = [];
  const api = createRigdApi(async (path, init) => {
    sent.push({ path, init });
    return reply(200, { result: { projects: [] } });
  });
  expect(await api.command({ action: "list" })).toEqual({ projects: [] });
  expect(sent[0]!.path).toBe("/api/command");
  expect(sent[0]!.init?.method).toBe("POST");
  expect(sent[0]!.init?.headers).toEqual({
    "content-type": "application/json",
  });
  const body = JSON.parse(sent[0]!.init?.body as string);
  expect(body.action).toBe("list");
  expect(typeof body.operationId).toBe("string");
});

test("health is a GET and the config editor posts to its own route", async () => {
  const sent: { path: string; method?: string }[] = [];
  const api = createRigdApi(async (path, init) => {
    sent.push({ path, method: init?.method });
    return path === "/api/health"
      ? reply(200, { instanceId: "i", pid: 1, running: true })
      : reply(200, { result: { revision: "r" } });
  });
  expect((await api.health()).pid).toBe(1);
  await api.config({ action: "read", project: "pantry" });
  expect(sent).toEqual([
    { path: "/api/health", method: "GET" },
    { path: "/api/config", method: "POST" },
  ]);
});

test("a refusal keeps its code, hint and operation; other failures are named, never swallowed", async () => {
  const refusing = createRigdApi(async () =>
    reply(422, {
      error: { code: "TARGETS_RUNNING", message: "Running.", hint: "Stop." },
      operationId: "op-1",
    }),
  );
  await expect(refusing.command({ action: "forget" })).rejects.toMatchObject({
    code: "TARGETS_RUNNING",
    message: "Running.",
    hint: "Stop.",
    operationId: "op-1",
  });
  const unreachable = createRigdApi(async () => {
    throw new TypeError("Failed to fetch");
  });
  await expect(unreachable.health()).rejects.toMatchObject({
    code: "DAEMON_UNREACHABLE",
  });
  const garbled = createRigdApi(
    async () => new Response("Not found", { status: 404 }),
  );
  await expect(garbled.health()).rejects.toBeInstanceOf(RigdError);
  const bare = createRigdApi(async () => reply(200, {}));
  await expect(bare.command({ action: "list" })).rejects.toMatchObject({
    code: "DAEMON_PROTOCOL",
  });
});

test("an abandoned read rejects as the abort, not as an unreachable daemon", async () => {
  const controller = new AbortController();
  const api = createRigdApi(async (_path, init) => {
    init?.signal?.throwIfAborted();
    return reply(200, { result: {} });
  });
  controller.abort();
  await expect(
    api.command({ action: "list" }, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("a Preview is selected by its deployment name, other Targets by their own", () => {
  expect(targetSelector({ kind: "preview", name: "feature-x" })).toEqual({
    target: "preview",
    deployment: "feature-x",
  });
  expect(targetSelector({ kind: "live", name: "prod" })).toEqual({
    target: "prod",
  });
});

test("session snapshots answer the last value and survive a refused storage", () => {
  const kept = new Map<string, string>();
  const storage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  };
  const first = sessionSnapshots(storage);
  expect(first.get("list")).toBeUndefined();
  first.set("list", { projects: [] });
  // A later page load reads what the earlier one stored.
  expect(sessionSnapshots(storage).get("list")).toEqual({ projects: [] });
  expect(kept.has("rig-dashboard:list")).toBe(true);
  const refused = sessionSnapshots({
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  });
  refused.set("health", { pid: 1 });
  expect(refused.get("health")).toEqual({ pid: 1 });
  expect(refused.get("queue")).toBeUndefined();
});

test("a route link carries the scheme Caddy serves it on", () => {
  expect(routeUrl("feat-x.rig.b-relay.com")).toBe(
    "https://feat-x.rig.b-relay.com",
  );
  expect(routeUrl("http://localhost:3000")).toBe("http://localhost:3000");
});
