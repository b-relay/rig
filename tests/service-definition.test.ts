import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnvironmentDigest,
  environmentKeyPath,
} from "../src/adapters/environment-digest";
import type { ManagedComponent, TargetPlan } from "../src/config/types";
import {
  canonicalJson,
  environmentText,
  serviceDefinition,
} from "../src/domain/service-definition";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const checkout = (id: string) => `/rig/targets/p/t/revisions/${id}`;
function db(at: string, extra: Partial<ManagedComponent> = {}) {
  return {
    name: "db",
    kind: "managed",
    command: `sh ${at}/scripts/rig-postgres.sh`,
    env: { PGDATA: "/rig/targets/p/t/data/db", SCRIPTS: `${at}/scripts` },
    envFiles: [{ path: `${at}/config/db.env`, required: true }],
    dependsOn: [],
    port: 5433,
    ports: { postgres: 5433 },
    readyTimeout: 30,
    stopTimeout: 10,
    restart: "always",
    ...extra,
  } satisfies ManagedComponent;
}
function plan(
  at: string,
  builds: TargetPlan["builds"] = [],
): Pick<TargetPlan, "workspacePath" | "builds"> {
  return { workspacePath: at, builds };
}

test("a Service's definition is the same from two checkouts when only the checkout path differs", () => {
  const a = checkout("a"),
    b = checkout("b");
  expect(serviceDefinition(plan(a), db(a))).toBe(
    serviceDefinition(plan(b), db(b)),
  );
  // Field order is not what it says.
  const { command, ...rest } = db(b);
  expect(serviceDefinition(plan(a), db(a))).toBe(
    serviceDefinition(plan(b), { ...rest, command }),
  );
});

test("every setting of the Service, its own build and the shared build are part of its definition; watch and other Services' builds are not", () => {
  const a = checkout("a"),
    b = checkout("b");
  const base = serviceDefinition(plan(a), db(a));
  for (const changed of [
    db(b, { command: "postgres -D data" }),
    db(b, { env: { PGDATA: "/elsewhere" } }),
    db(b, { envFiles: [] }),
    db(b, { port: 5434, ports: { postgres: 5434 } }),
    db(b, { dependsOn: ["search"] }),
    db(b, { health: "pg_isready" }),
    db(b, {
      healthcheck: {
        interval: 30,
        timeout: 5,
        retries: 3,
        onFailure: "report",
      },
    }),
    db(b, { stopTimeout: 60 }),
    db(b, { restart: "on-failure" }),
    db(b, { workingDir: "db" }),
  ])
    expect(serviceDefinition(plan(b), changed)).not.toBe(base);
  expect(
    serviceDefinition(
      plan(b, [{ id: "shared", command: "make", timeout: 600 }]),
      db(b),
    ),
  ).not.toBe(base);
  expect(
    serviceDefinition(
      plan(b, [
        { id: "service:db", component: "db", command: "initdb", timeout: 600 },
      ]),
      db(b),
    ),
  ).not.toBe(base);
  expect(
    serviceDefinition(
      plan(b, [
        {
          id: "service:web",
          component: "web",
          command: "vite build",
          timeout: 600,
        },
      ]),
      db(b),
    ),
  ).toBe(base);
  expect(
    serviceDefinition(plan(b), db(b, { watch: ["scripts/rig-postgres.sh"] })),
  ).toBe(base);
});

test("the environment text normalizes the checkout in values and sorts names", () => {
  expect(
    environmentText({ B: "2", A: `${checkout("a")}/bin` }, checkout("a")),
  ).toBe(environmentText({ A: `${checkout("b")}/bin`, B: "2" }, checkout("b")));
  expect(canonicalJson({ b: { d: 1, c: [2, 1] }, a: 0 })).toBe(
    '{"a":0,"b":{"c":[2,1],"d":1}}',
  );
});

test("an environment digest is keyed by a 0600 key rigd writes once, equal across checkouts and never the value", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-env-digest-"));
  roots.push(root);
  const digest = createEnvironmentDigest(root);
  const secret = { TYPESENSE_API_KEY: "hunter2", HOME: checkout("a") };
  const first = await digest(secret, checkout("a"));
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(first).not.toContain("hunter2");
  expect(await digest({ ...secret, HOME: checkout("b") }, checkout("b"))).toBe(
    first,
  );
  expect(
    await digest({ ...secret, TYPESENSE_API_KEY: "rotated" }, checkout("a")),
  ).not.toBe(first);
  const key = environmentKeyPath(root);
  expect((await stat(key)).mode & 0o777).toBe(0o600);
  // Another rigd over the same root reads the same key, so digests survive a restart.
  expect(await createEnvironmentDigest(root)(secret, checkout("a"))).toBe(
    first,
  );
  // A different key gives a different digest: the digest alone does not reveal a guessable value.
  const other = await mkdtemp(join(tmpdir(), "rig-env-digest-other-"));
  roots.push(other);
  expect(await createEnvironmentDigest(other)(secret, checkout("a"))).not.toBe(
    first,
  );
  expect((await readFile(key, "utf8")).length).toBeGreaterThan(20);
});

test("a key Rig did not write fails ENV_DIGEST with the path to delete", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-env-digest-bad-"));
  roots.push(root);
  const digest = createEnvironmentDigest(root);
  await digest({}, "/x");
  await writeFile(environmentKeyPath(root), "x");
  await expect(createEnvironmentDigest(root)({}, "/x")).rejects.toMatchObject({
    code: "ENV_DIGEST",
    hint: expect.stringContaining(environmentKeyPath(root)),
  });
});
