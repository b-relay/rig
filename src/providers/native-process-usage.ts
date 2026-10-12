import { dlopen, FFIType, ptr } from "bun:ffi";
import type { ProcessReading } from "../domain/usage-sample";
import type { ProcessUsageReader } from "./process-usage";

const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
/** `RUSAGE_INFO_V4`: the newest `proc_pid_rusage` layout every supported macOS has. */
const RUSAGE_INFO_V4 = 4;
/** `struct rusage_info_v4` is 296 bytes; the buffer is larger so a newer kernel can never write past it. */
const RUSAGE_WORDS = 64;
/** Byte offsets in `struct rusage_info_v4` (after the 16-byte uuid, every field is a uint64). */
const USER_TIME = 16;
const SYSTEM_TIME = 24;
const PHYS_FOOTPRINT = 72;
/** At most this many children or group members are read per process. */
const PID_CAPACITY = 4096;

/** Reads process usage straight from the macOS kernel through `bun:ffi`: `proc_pid_rusage` for CPU time and physical
 * footprint, `proc_listchildpids` and `proc_listpgrppids` for the tree. One read of a process takes microseconds and
 * starts no process, so rigd can read every second. `undefined` where the calls are unavailable (not macOS, or the
 * library cannot be loaded); rigd then uses the `ps` reader. */
export function createNativeProcessUsageReader():
  ProcessUsageReader | undefined {
  if (process.platform !== "darwin") return undefined;
  const library = load();
  if (!library) return undefined;
  const { symbols } = library;
  const timebase = new Uint32Array(2);
  symbols.mach_timebase_info(ptr(timebase));
  const ticksToNs = timebase[0]! / timebase[1]!;
  const usage = new BigUint64Array(RUSAGE_WORDS);
  const pids = new Int32Array(PID_CAPACITY);

  const readOne = (pid: number): ProcessReading | undefined => {
    if (symbols.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(usage)) !== 0)
      return undefined;
    const ticks = usage[USER_TIME / 8]! + usage[SYSTEM_TIME / 8]!;
    return {
      pid,
      cpuNs: Number(ticks) * ticksToNs,
      memoryBytes: Number(usage[PHYS_FOOTPRINT / 8]!),
    };
  };
  const related = (pid: number): number[] => {
    const found: number[] = [];
    for (const list of [
      symbols.proc_listchildpids,
      symbols.proc_listpgrppids,
    ]) {
      const count = list(pid, ptr(pids), pids.byteLength);
      for (let i = 0; i < Math.min(count, PID_CAPACITY); i++)
        found.push(pids[i]!);
    }
    return found;
  };
  const tree = (root: number): ProcessReading[] | undefined => {
    const first = readOne(root);
    if (!first) return undefined;
    const readings = [first];
    const owned = new Set([root]);
    const queue = [root];
    while (queue.length > 0) {
      for (const pid of related(queue.shift()!)) {
        if (owned.has(pid)) continue;
        owned.add(pid);
        const reading = readOne(pid);
        if (!reading) continue;
        readings.push(reading);
        queue.push(pid);
      }
    }
    return readings;
  };
  return {
    intervalMs: 1000,
    kind: "native",
    async read(roots) {
      const trees = new Map<number, readonly ProcessReading[]>();
      for (const root of roots) {
        const readings = tree(root);
        if (readings) trees.set(root, readings);
      }
      return trees;
    },
  };
}

function load() {
  try {
    return dlopen(LIBSYSTEM, {
      proc_pid_rusage: {
        args: [FFIType.i32, FFIType.i32, FFIType.ptr],
        returns: FFIType.i32,
      },
      proc_listchildpids: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
      proc_listpgrppids: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
      mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
    });
  } catch {
    return undefined;
  }
}
