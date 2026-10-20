import type { WorkReport } from "./contracts";

/** A WorkReport that remembers which of its work is failing, so the work that is no longer needed can be let go of. */
export interface TrackedWorkReport extends WorkReport {
  /** Whether `work` failed and has not succeeded since. */
  failing(work: string): boolean;
  /** Every failing work that `needed` rejects (its Target or job is gone, say) is reported as no longer needed. */
  only(needed: (work: string) => boolean): void;
}

/** Tracks what `report` was told; with no `report`, it only tracks. A success of work that was not failing reports nothing. */
export function trackedWorkReport(report?: WorkReport): TrackedWorkReport {
  const failing = new Set<string>();
  const succeeded = (work: string) => {
    if (failing.delete(work)) report?.succeeded(work);
  };
  return {
    failed(work, about, error) {
      failing.add(work);
      report?.failed(work, about, error);
    },
    succeeded,
    failing: (work) => failing.has(work),
    only(needed) {
      for (const work of [...failing]) if (!needed(work)) succeeded(work);
    },
  };
}
