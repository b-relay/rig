import { recordActivity, type ServiceActivity } from "../domain/activity";
import type { Clock } from "../domain/clock";
import { droppedActivity } from "../domain/health-wording";
import type {
  OperationRecord,
  StateStore,
  TargetRecord,
} from "../domain/runtime";
import { healthKey, type HealthCache } from "./health-cache";
import type { TrackedWorkReport } from "./work-report";

/** How many writes about one Service's changes of health are kept while the state cannot be written. Each is one bounded
 * line (its check's output is cut to 200 characters), so this bounds their bytes too. */
export const UNWRITTEN_HEALTH_LIMIT = 8;

/** The health monitor's writes to state about a change of a Service's health: an Activity entry, or the end of its unhealthy
 * stretch on the run record. Each is queued and applied in order while the cache still holds it current, compared again
 * inside the store's update; one the store refuses waits, with those after it, for `write` to be called again. */
export interface HealthRecords {
  /** Queues an Activity entry about the Service, made now, and writes the queue. */
  activity(
    target: TargetRecord,
    service: string,
    since: number,
    entry: ServiceActivity,
  ): Promise<void>;
  /** Queues the end of the Service's unhealthy stretch for `incarnation`, once per process, and writes the queue. */
  stretchEnded(
    target: TargetRecord,
    service: string,
    since: number,
    incarnation: string | undefined,
  ): Promise<void>;
  /** Writes the queue of the Service at `key`. */
  write(key: string): Promise<void>;
  /** The keys of the Services with writes waiting, oldest first. */
  waiting(): string[];
  has(key: string): boolean;
  /** How many writes wait. */
  retained(): number;
}

export interface HealthRecordsDependencies {
  store: Pick<StateStore, "update">;
  clock: Clock;
  id(): string;
  cache: Pick<HealthCache, "current">;
  report: Pick<TrackedWorkReport, "succeeded">;
  /** Reports a write that failed. */
  failed(
    work: string,
    about: string,
    target: Pick<TargetRecord, "name">,
    error: unknown,
  ): Promise<void>;
}

/** A write about a change of a Service's health not made yet: its Activity entry, or the end of its unhealthy stretch. */
type HealthChange =
  | {
      kind: "activity";
      entry: Pick<
        OperationRecord,
        "action" | "outcome" | "message" | "id" | "occurredAt"
      >;
    }
  | { kind: "stretch-ended"; incarnation?: string };
/** A queued write, applied only while a write derived from `since` is current; it names its Target by what the write needs. */
interface UnwrittenRecord {
  target: { id: string; projectId: string; name: string; project: string };
  service: string;
  since: number;
  change: HealthChange;
}
/** A Service's unwritten changes of health, oldest first, and how many older ones were dropped past the limit. */
interface UnwrittenQueue {
  records: UnwrittenRecord[];
  dropped: number;
}

export function createHealthRecords(
  deps: HealthRecordsDependencies,
): HealthRecords {
  const unwritten = new Map<string, UnwrittenQueue>();
  const { current } = deps.cache;

  /** Queues `change` behind the writes not made yet, then writes the queue. The queue is bounded: the end of a stretch is
   * queued once per process, and past UNWRITTEN_HEALTH_LIMIT the oldest Activity entry is dropped and counted, so a Service
   * that flaps through a long storage outage holds a few small entries, never one per check. */
  async function change(
    target: TargetRecord,
    service: string,
    since: number,
    change: HealthChange,
  ): Promise<void> {
    if (!current(target.id, service, since)) return;
    const key = healthKey(target.id, service);
    const queue = unwritten.get(key) ?? { records: [], dropped: 0 };
    unwritten.set(key, queue);
    const queued = queue.records;
    if (
      change.kind === "activity" ||
      !queued.some(
        (other) =>
          other.change.kind === "stretch-ended" &&
          other.change.incarnation === change.incarnation,
      )
    )
      queued.push({
        target: {
          id: target.id,
          projectId: target.projectId,
          name: target.name,
          project: target.plan.project,
        },
        service,
        since,
        change,
      });
    while (queued.length > UNWRITTEN_HEALTH_LIMIT) {
      const oldest = queued.findIndex(
        (other) => other.change.kind === "activity",
      );
      queued.splice(oldest === -1 ? 0 : oldest, 1);
      queue.dropped++;
    }
    await write(key);
  }

  /** Writes the queue in order, each while current, led by an Activity entry that says how many were dropped; one that
   * fails is reported, with how many wait, and kept, with those after it. */
  async function write(key: string): Promise<void> {
    const queue = unwritten.get(key);
    if (!queue) return;
    const queued = queue.records;
    while (queued.length) {
      const { target, service, since, change } = queued[0]!;
      if (current(target.id, service, since))
        try {
          await deps.store.update((state) => {
            // Compared again as it is applied: a transition may have come through while the store was busy.
            if (!current(target.id, service, since)) return;
            const activity = (
              entry: Pick<
                OperationRecord,
                "id" | "occurredAt" | "action" | "outcome" | "message"
              >,
            ) =>
              recordActivity(state, {
                projectId: target.projectId,
                project: state.projects.find((p) => p.id === target.projectId)
                  ?.name,
                target: target.name,
                component: { kind: "service", name: service },
                ...entry,
              });
            // Said at the oldest change kept, which the dropped ones came before.
            if (queue.dropped)
              activity({
                id: deps.id(),
                occurredAt:
                  queued.find(
                    (
                      other,
                    ): other is UnwrittenRecord & {
                      change: { kind: "activity" };
                    } => other.change.kind === "activity",
                  )?.change.entry.occurredAt ??
                  new Date(deps.clock.now()).toISOString(),
                ...droppedActivity(service, queue.dropped),
              });
            if (change.kind === "activity") activity(change.entry);
            else {
              const run = state.targets.find((t) => t.id === target.id)
                ?.services?.[service];
              if (run?.healthStretch && run.incarnation === change.incarnation)
                delete run.healthStretch;
            }
          });
          queue.dropped = 0;
        } catch (error) {
          const waiting = `${queued.length} ${queued.length === 1 ? "change" : "changes"} waiting${queue.dropped ? `, ${queue.dropped} older dropped` : ""}`;
          await deps.failed(
            `${key}/record`,
            `Recording the changes of health of ${service} on ${target.name} of ${target.project} (${waiting})`,
            target,
            error,
          );
          return;
        }
      queued.shift();
    }
    unwritten.delete(key);
    deps.report.succeeded(`${key}/record`);
  }

  return {
    async activity(target, service, since, entry) {
      await change(target, service, since, {
        kind: "activity",
        entry: {
          ...entry,
          id: deps.id(),
          occurredAt: new Date(deps.clock.now()).toISOString(),
        },
      });
    },
    async stretchEnded(target, service, since, incarnation) {
      await change(target, service, since, {
        kind: "stretch-ended",
        ...(incarnation !== undefined ? { incarnation } : {}),
      });
    },
    write,
    waiting: () => [...unwritten.keys()],
    has: (key) => unwritten.has(key),
    retained: () =>
      [...unwritten.values()].reduce(
        (count, queue) => count + queue.records.length,
        0,
      ),
  };
}
