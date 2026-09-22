import { test, expect } from "bun:test";
import { createRigdApi, RigdError } from "../web/dashboard/api";
import { routeUrl, targetSelector } from "../web/dashboard/target";
import { SNAPSHOT_FORMAT, sessionSnapshots } from "../web/dashboard/hooks";

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

const mapStorage = (kept: Map<string, string>) => ({
  getItem: (key: string) => kept.get(key) ?? null,
  setItem: (key: string, value: string) => void kept.set(key, value),
  removeItem: (key: string) => void kept.delete(key),
  key: (index: number) => [...kept.keys()][index] ?? null,
  get length() {
    return kept.size;
  },
});

test("session snapshots answer the last value and survive a refused storage", () => {
  const kept = new Map<string, string>();
  const first = sessionSnapshots(mapStorage(kept));
  expect(first.get("list")).toBeUndefined();
  first.set("list", { projects: [] });
  // A later page load reads what the earlier one stored, under this build's format.
  expect(sessionSnapshots(mapStorage(kept)).get("list")).toEqual({
    projects: [],
  });
  expect(kept.has(`rig-dashboard:${SNAPSHOT_FORMAT}:list`)).toBe(true);
  expect(sessionSnapshots(mapStorage(kept), "other:").get("list")).toBe(
    undefined,
  );
  const denied = () => {
    throw new Error("denied");
  };
  const refused = sessionSnapshots({
    getItem: denied,
    setItem: denied,
    removeItem: denied,
    key: denied,
    length: 0,
  });
  refused.set("health", { pid: 1 });
  expect(refused.get("health")).toEqual({ pid: 1 });
  expect(refused.get("queue")).toBeUndefined();
  refused.forget();
  expect(refused.get("health")).toBeUndefined();
});

test("forgetting snapshots leaves other storage alone", () => {
  const kept = new Map<string, string>([["theirs", "1"]]);
  const snapshots = sessionSnapshots(mapStorage(kept));
  snapshots.set("list", { projects: [] });
  snapshots.set("health", { pid: 1 });
  snapshots.forget();
  expect(snapshots.get("list")).toBeUndefined();
  expect([...kept.keys()]).toEqual(["theirs"]);
});

test("a route link carries the scheme Caddy serves it on", () => {
  expect(routeUrl("feat-x.rig.b-relay.com")).toBe(
    "https://feat-x.rig.b-relay.com",
  );
  expect(routeUrl("http://localhost:3000")).toBe("http://localhost:3000");
});
