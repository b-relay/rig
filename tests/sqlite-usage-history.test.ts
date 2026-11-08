import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteUsageHistory } from "../src/adapters/sqlite-usage-history";
import { storedSample } from "../src/domain/usage-minute";
import type { UsageSeries } from "../src/runtime/usage-history";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const PROJECT: UsageSeries = {
  scope: "project",
  projectId: "p1",
  project: "pantry",
};
/** A store holding one minute of `series`, and a read of the Host's series over that minute. */
async function stored(series: UsageSeries) {
  const root = await mkdtemp(join(tmpdir(), "rig-usage-store-"));
  roots.push(root);
  const path = join(root, "usage.sqlite");
  const history = openSqliteUsageHistory(path);
  await history.write([
    {
      series,
      minute: 100,
      slots: [storedSample({ cpuPercent: 5, memoryBytes: 4096 })],
    },
  ]);
  const read = () =>
    history.read({
      filter: { kind: "host" },
      from: 6000,
      to: 6060,
      detail: true,
    });
  return { path, history, read };
}

test.each([
  ["null", "null"],
  ["an unknown scope", '{"scope":"galaxy"}'],
  ["a project series without its id", '{"scope":"project","project":"pantry"}'],
  ["malformed JSON", "{"],
])(
  "a stored series label holding %s is refused as MONITOR_STORAGE, never charted as another series",
  async (_, label) => {
    const store = await stored(PROJECT);
    const db = new Database(store.path);
    db.run("UPDATE series SET label = ?", [label]);
    db.close();
    await expect(store.read()).rejects.toMatchObject({
      code: "MONITOR_STORAGE",
      message: `rigd's CPU and memory history at ${store.path} names a series it cannot read.`,
      hint: expect.stringMatching(
        /^A series label (has an invalid value at|is not valid JSON).*A damaged usage\.sqlite can be deleted: rigd starts a new one, losing only Monitor's history\.$/,
      ),
      details: { path: store.path },
    });
    await store.history.close();
  },
);

test("a stored series label reads back as the series it was written for", async () => {
  const store = await stored(PROJECT);
  expect((await store.read()).map((each) => each.series)).toEqual([PROJECT]);
  await store.history.close();
});
