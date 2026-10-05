import type { TargetRecord } from "../domain/runtime";

/** What an Operation holds while it runs: a path from the Host down. `[]` is the whole Host,
 * `["project", id]` one Project with all its Targets, `["project", id, "target", …]` one Target.
 * Two scopes conflict when one path is a prefix of the other, so the Host scope conflicts with
 * everything, a Project scope with each of its Targets, and Targets of one Project with nothing
 * but themselves. */
export type LockScope = readonly string[];

/** The whole Host: every Project and Target waits while it is held. */
export const HOST_SCOPE: LockScope = [];

/** One Project and every Target it has. */
export function projectScope(projectId: string): LockScope {
  return ["project", projectId];
}

/** One Target. The working and stable Targets are keyed by role, which is also their name; a Preview by its name. */
export function targetScope(
  projectId: string,
  target: Pick<TargetRecord, "kind" | "name">,
): LockScope {
  return target.kind === "preview"
    ? ["project", projectId, "target", "preview", target.name]
    : ["project", projectId, "target", target.kind];
}

/** A Project's rig.yaml as an edit writes it. Within the Project, so a rename or repoint waits for an edit, but beside
 * every Target, so an edit never waits for a Target's stop or build. */
export function configScope(projectId: string): LockScope {
  return ["project", projectId, "config"];
}

/** Every Target of one Project, as a query: whether any operation works on one of them. Nothing is
 * admitted under it. */
export function projectTargetsScope(projectId: string): LockScope {
  return ["project", projectId, "target"];
}

/** A Project name that is being registered, so two registrations of one name cannot both succeed. */
export function registrationScope(name: string): LockScope {
  return ["registration", name];
}

/** Scopes held by one Operation. Release is idempotent. */
export interface Lease {
  readonly id: string;
  readonly scopes: readonly LockScope[];
  release(): void;
  /** Hands the scopes this lease holds on to new leases in one step, so nothing queued behind this
   * lease runs in between. Each part's scopes must lie within this lease's; this lease ends. */
  split(
    parts: readonly { id: string; scopes: readonly LockScope[] }[],
  ): Lease[];
}

/** Where a waiting request stands: the held leases it conflicts with and the earlier waiting requests it
 * waits behind, by id, oldest first. */
export interface WaitPosition {
  holders: string[];
  queued: string[];
}

/** First-come, first-served locks over hierarchical scopes. A request takes all its scopes at once
 * or waits holding none, so two requests never wait on each other. A request never overtakes an
 * earlier one it conflicts with, so a Project or Host request is not starved by a stream of Target
 * requests. In memory only; no I/O. */
export interface OperationLocks {
  /** Resolves once no held lease and no earlier waiting request conflicts with `scopes`. */
  acquire(id: string, scopes: readonly LockScope[]): Promise<Lease>;
  /** The lease when it could be granted now without waiting; otherwise undefined and nothing is queued. */
  tryAcquire(id: string, scopes: readonly LockScope[]): Lease | undefined;
  /** Undefined unless the request `id` is waiting. */
  position(id: string): WaitPosition | undefined;
  /** Whether any held lease or waiting request conflicts with `scope`, apart from those whose id `ignore` accepts. */
  busy(scope: LockScope, ignore?: (id: string) => boolean): boolean;
  /** The ids of every held lease, oldest first. */
  holders(): string[];
  /** How many requests are waiting. */
  waiting(): number;
  /** Resolves once no lease is held and no request waits. */
  idle(): Promise<void>;
}

/** Whether two scope sets conflict: some scope of one is a prefix of some scope of the other. */
export function scopesConflict(
  a: readonly LockScope[],
  b: readonly LockScope[],
): boolean {
  return a.some((x) => b.some((y) => prefixRelated(x, y)));
}

function prefixRelated(a: LockScope, b: LockScope): boolean {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++)
    if (a[index] !== b[index]) return false;
  return true;
}

interface Request {
  id: string;
  scopes: readonly LockScope[];
  grant(lease: Lease): void;
}

export function createOperationLocks(): OperationLocks {
  const held = new Map<symbol, { id: string; scopes: readonly LockScope[] }>();
  const queue: Request[] = [];
  let idleWaiters: (() => void)[] = [];

  const grantable = (scopes: readonly LockScope[], before: number) =>
    ![...held.values()].some((lease) => scopesConflict(lease.scopes, scopes)) &&
    !queue
      .slice(0, before)
      .some((request) => scopesConflict(request.scopes, scopes));

  const lease = (id: string, scopes: readonly LockScope[]): Lease => {
    const key = Symbol(id);
    held.set(key, { id, scopes });
    let ended = false;
    const end = () => {
      if (ended) return false;
      ended = true;
      held.delete(key);
      return true;
    };
    return {
      id,
      scopes,
      release() {
        if (end()) settle();
      },
      split(parts) {
        if (ended) throw new Error(`Lease ${id} has already ended.`);
        for (const part of parts)
          if (
            !part.scopes.every((scope) =>
              scopes.some((own) => isWithin(scope, own)),
            )
          )
            throw new Error(`Lease ${part.id} is not within ${id}.`);
        end();
        const leases = parts.map((part) => lease(part.id, part.scopes));
        settle();
        return leases;
      },
    };
  };

  /** Grants every waiting request that no holder and no earlier waiter blocks, in queue order. */
  const settle = () => {
    for (let index = 0; index < queue.length;) {
      const request = queue[index]!;
      if (grantable(request.scopes, index)) {
        queue.splice(index, 1);
        request.grant(lease(request.id, request.scopes));
      } else index++;
    }
    if (!held.size && !queue.length) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };

  return {
    acquire(id, scopes) {
      return new Promise<Lease>((grant) => {
        queue.push({ id, scopes, grant });
        settle();
      });
    },
    tryAcquire(id, scopes) {
      return grantable(scopes, queue.length) ? lease(id, scopes) : undefined;
    },
    position(id) {
      const index = queue.findIndex((request) => request.id === id);
      if (index < 0) return undefined;
      const { scopes } = queue[index]!;
      return {
        holders: [...held.values()]
          .filter((lease) => scopesConflict(lease.scopes, scopes))
          .map((lease) => lease.id),
        queued: queue
          .slice(0, index)
          .filter((request) => scopesConflict(request.scopes, scopes))
          .map((request) => request.id),
      };
    },
    busy: (scope, ignore) =>
      [...held.values(), ...queue].some(
        (entry) => !ignore?.(entry.id) && scopesConflict(entry.scopes, [scope]),
      ),
    holders: () => [...held.values()].map((lease) => lease.id),
    waiting: () => queue.length,
    idle() {
      if (!held.size && !queue.length) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}

/** Whether `inner` names the same resource as `outer` or one below it. */
export function isWithin(inner: LockScope, outer: LockScope): boolean {
  return (
    inner.length >= outer.length &&
    outer.every((part, index) => inner[index] === part)
  );
}
