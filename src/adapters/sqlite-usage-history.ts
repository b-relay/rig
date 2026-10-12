import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decodeHistogram, encodeHistogram } from "../domain/usage-histogram";
import {
  decodeMinute,
  encodeMinute,
  histogramsOf,
  SLOTS_PER_MINUTE,
  type StoredSample,
} from "../domain/usage-minute";
import {
  seriesKey,
  type SeriesHistory,
  type UsageHistory,
  type UsageSeries,
} from "../runtime/usage-history";

const SCHEMA_VERSION = 2;

/** Usage history in SQLite at `path` (`<RIG_ROOT>/monitor/usage.sqlite`), created on first use. Detail is one row of 60
 * packed slots per series and minute; history one row of two histograms per series and minute. The database is in WAL
 * mode so the dashboard's reads never wait behind rigd's writes. */
export function openSqliteUsageHistory(path: string): UsageHistory {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  migrate(db);

  const upsertSeries = db.query<
    { id: number },
    [string, string, string | null, string | null, string]
  >(
    `INSERT INTO series (key, scope, project_id, target_id, label) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET label = excluded.label RETURNING id`,
  );
  const readDetail = db.query<{ slots: Uint8Array }, [number, number]>(
    "SELECT slots FROM detail WHERE series = ? AND minute = ?",
  );
  const writeDetail = db.query<null, [number, number, Uint8Array]>(
    "INSERT OR REPLACE INTO detail (series, minute, slots) VALUES (?, ?, ?)",
  );
  const writeHistory = db.query<null, [number, number, Uint8Array, Uint8Array]>(
    "INSERT OR REPLACE INTO history (series, minute, cpu, memory) VALUES (?, ?, ?, ?)",
  );

  const write = db.transaction(
    (minutes: Parameters<UsageHistory["write"]>[0]) => {
      for (const recorded of minutes) {
        const id = upsertSeries.get(
          seriesKey(recorded.series),
          recorded.series.scope,
          "projectId" in recorded.series ? recorded.series.projectId : null,
          "targetId" in recorded.series ? recorded.series.targetId : null,
          JSON.stringify(recorded.series),
        )!.id;
        const stored = readDetail.get(id, recorded.minute);
        const slots = merged(
          stored ? decodeMinute(stored.slots) : [],
          recorded.slots,
        );
        const histograms = histogramsOf(slots);
        if (!histograms) continue;
        writeDetail.run(id, recorded.minute, encodeMinute(slots));
        writeHistory.run(
          id,
          recorded.minute,
          encodeHistogram(histograms.cpu),
          encodeHistogram(histograms.memory),
        );
      }
    },
  );

  return {
    async write(minutes) {
      write(minutes);
    },
    async read(request) {
      const series = selectedSeries(db, request.filter);
      const fromMinute = Math.floor(request.from / 60);
      const toMinute = Math.ceil(request.to / 60);
      return series.map(({ id, label }): SeriesHistory => {
        const spans: SeriesHistory["spans"][number][] = [];
        if (request.detail) {
          const rows = db
            .query<
              { minute: number; slots: Uint8Array },
              [number, number, number]
            >(
              "SELECT minute, slots FROM detail WHERE series = ? AND minute >= ? AND minute < ? ORDER BY minute",
            )
            .all(id, fromMinute, toMinute);
          for (const row of rows)
            decodeMinute(row.slots).forEach((slot, second) => {
              const at = row.minute * 60 + second;
              const histograms = slot && histogramsOf([slot]);
              if (histograms && at >= request.from && at < request.to)
                spans.push({ at, histograms });
            });
        } else {
          const rows = db
            .query<
              { minute: number; cpu: Uint8Array; memory: Uint8Array },
              [number, number, number]
            >(
              "SELECT minute, cpu, memory FROM history WHERE series = ? AND minute >= ? AND minute < ? ORDER BY minute",
            )
            .all(id, fromMinute, toMinute);
          for (const row of rows) {
            const cpu = decodeHistogram(row.cpu);
            const memory = decodeHistogram(row.memory);
            if (cpu && memory)
              spans.push({ at: row.minute * 60, histograms: { cpu, memory } });
          }
        }
        return { series: JSON.parse(label) as UsageSeries, spans };
      });
    },
    async prune(input) {
      db.transaction(() => {
        db.run("DELETE FROM detail WHERE minute < ?", [
          Math.floor(input.detailBefore / 60),
        ]);
        db.run(
          `INSERT INTO pruned (id, detail_before) VALUES (0, ?)
             ON CONFLICT (id) DO UPDATE SET detail_before = max(detail_before, excluded.detail_before)`,
          [Math.floor(input.detailBefore / 60) * 60],
        );
        db.run("DELETE FROM history WHERE minute < ?", [
          Math.floor(input.historyBefore / 60),
        ]);
        db.run(
          `DELETE FROM series WHERE NOT EXISTS (SELECT 1 FROM history WHERE history.series = series.id)
             AND NOT EXISTS (SELECT 1 FROM detail WHERE detail.series = series.id)`,
        );
      })();
    },
    async detailPrunedBefore() {
      return (
        db
          .query<{ detail_before: number }, []>(
            "SELECT detail_before FROM pruned WHERE id = 0",
          )
          .get()?.detail_before ?? 0
      );
    },
    async forget(projectId) {
      db.transaction(() => {
        const ids = db
          .query<{ id: number }, [string]>(
            "SELECT id FROM series WHERE project_id = ?",
          )
          .all(projectId)
          .map((row) => row.id);
        for (const id of ids) {
          db.run("DELETE FROM detail WHERE series = ?", [id]);
          db.run("DELETE FROM history WHERE series = ?", [id]);
          db.run("DELETE FROM series WHERE id = ?", [id]);
        }
      })();
    },
    async close() {
      db.close();
    },
  };
}

function migrate(db: Database): void {
  const version = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!.user_version;
  if (version === SCHEMA_VERSION) return;
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      project_id TEXT,
      target_id TEXT,
      label TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS detail (
      series INTEGER NOT NULL,
      minute INTEGER NOT NULL,
      slots BLOB NOT NULL,
      PRIMARY KEY (series, minute)
    ) WITHOUT ROWID`);
    db.run(`CREATE TABLE IF NOT EXISTS history (
      series INTEGER NOT NULL,
      minute INTEGER NOT NULL,
      cpu BLOB NOT NULL,
      memory BLOB NOT NULL,
      PRIMARY KEY (series, minute)
    ) WITHOUT ROWID`);
    // How far detail has been pruned, so a report never looks for seconds already gone when retention grows.
    db.run(`CREATE TABLE IF NOT EXISTS pruned (
      id INTEGER PRIMARY KEY CHECK (id = 0),
      detail_before INTEGER NOT NULL
    )`);
    db.run("CREATE INDEX IF NOT EXISTS detail_minute ON detail (minute)");
    db.run("CREATE INDEX IF NOT EXISTS history_minute ON history (minute)");
    db.run("CREATE INDEX IF NOT EXISTS series_project ON series (project_id)");
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
}

function selectedSeries(
  db: Database,
  filter: Parameters<UsageHistory["read"]>[0]["filter"],
): { id: number; label: string }[] {
  return filter.kind === "host"
    ? db
        .query<{ id: number; label: string }, []>(
          "SELECT id, label FROM series WHERE scope IN ('host', 'rig', 'project') ORDER BY key",
        )
        .all()
    : db
        .query<{ id: number; label: string }, [string]>(
          "SELECT id, label FROM series WHERE project_id = ? ORDER BY key",
        )
        .all(filter.projectId);
}

/** Slot by slot, the new sample where there is one and the stored one otherwise. */
function merged(
  stored: readonly (StoredSample | undefined)[],
  fresh: readonly (StoredSample | undefined)[],
): (StoredSample | undefined)[] {
  return Array.from(
    { length: SLOTS_PER_MINUTE },
    (_, second) => fresh[second] ?? stored[second],
  );
}
