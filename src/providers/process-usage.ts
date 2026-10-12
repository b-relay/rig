import type { ProcessReading } from "../domain/usage-sample";

/** Reads what running processes use, for rigd's usage sampler. */
export interface ProcessUsageReader {
  /** How often the reader should be asked, in milliseconds: what one read costs the Host decides it. */
  readonly intervalMs: number;
  /** Which reader this is, for diagnostics and `rig doctor`: `native` reads the kernel directly, `ps` runs `/bin/ps`. */
  readonly kind: "native" | "ps";
  /** Each root's process tree as it is now: the root, its descendants, and every member of a process group one of them
   * leads (a child whose parent already exited keeps its group). A root that is no longer running is absent from the
   * result. Rejects only when the process table cannot be read at all. */
  read(
    roots: readonly number[],
  ): Promise<ReadonlyMap<number, readonly ProcessReading[]>>;
}
