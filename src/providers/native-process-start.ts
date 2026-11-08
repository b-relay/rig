import { RigError } from "../domain/errors";

const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
const CTL_KERN = 1;
const KERN_PROC = 14;
const KERN_PROC_PID = 1;
/** `struct kinfo_proc` is 648 bytes and begins with the process's start time; the buffer is larger so a newer kernel's fits. */
const KINFO_WORDS = 256;
/** `LC_ALL_MASK` in macOS's `xlocale.h`. */
const LC_ALL_MASK = 63;
/** `struct tm` is 56 bytes; the buffer is larger, as above. */
const TM_WORDS = 16;
const TEXT_BYTES = 256;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const two = (value: number) => String(value).padStart(2, "0");

/** When a process started, in Unix seconds; undefined when no process has the pid. Throws PROCESS_INSPECT when the kernel refuses to say. */
export type ProcessStartReader = (pid: number) => number | undefined;

export interface NativeProcessStart {
  readonly start: ProcessStartReader;
  /** A start time as `ps -o lstart=` prints it for this process: `%c` under the zone and locale of its environment, by the
   * same library calls, not JavaScript's `Date`, whose zone rules differ. Undefined when the locale cannot be loaded. */
  printed(seconds: number): string | undefined;
}

let loaded: Promise<NativeProcessStart | undefined> | undefined;

/** Reads a process's start from the macOS kernel through `bun:ffi`: `sysctl(KERN_PROC_PID)`, the record `ps` itself reads,
 * so it answers for a zombie and for another user's process as `ps` does, and starts no process. `undefined` where the call
 * is unavailable (not macOS, or the library cannot be loaded); the caller then runs `ps`. Imported on first use, and past
 * the dashboard's bundler, which cannot resolve `bun:ffi`. */
export function nativeProcessStart(): Promise<NativeProcessStart | undefined> {
  loaded ??= load();
  return loaded;
}

async function load(): Promise<NativeProcessStart | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { dlopen, FFIType, ptr } = await import(
      /* turbopackIgnore: true */ "bun:ffi"
    );
    const { symbols } = dlopen(LIBSYSTEM, {
      sysctl: {
        args: [
          FFIType.ptr,
          FFIType.u32,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.u64,
        ],
        returns: FFIType.i32,
      },
      tzset: { args: [], returns: FFIType.void },
      localtime_r: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.ptr,
      },
      newlocale: {
        args: [FFIType.i32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.ptr,
      },
      strftime_l: {
        args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.u64,
      },
    });
    const encode = (text: string) => new TextEncoder().encode(`${text}\0`);
    symbols.tzset();
    const locale = symbols.newlocale(LC_ALL_MASK, ptr(encode("")), null);
    const format = encode("%c");
    const time = new BigInt64Array(1);
    const fields = new BigInt64Array(TM_WORDS);
    const text = new Uint8Array(TEXT_BYTES);
    return {
      start: kernelStartReader((name, info, size) =>
        symbols.sysctl(ptr(name), 4, ptr(info), ptr(size), null, 0),
      ),
      printed(seconds) {
        if (locale === null) return undefined;
        time[0] = BigInt(seconds);
        if (symbols.localtime_r(ptr(time), ptr(fields)) === null)
          return undefined;
        const length = Number(
          symbols.strftime_l(
            ptr(text),
            TEXT_BYTES,
            ptr(format),
            ptr(fields),
            locale,
          ),
        );
        return length === 0
          ? undefined
          : new TextDecoder().decode(text.subarray(0, length)).trim();
      },
    };
  } catch {
    return undefined;
  }
}

/** `sysctl(3)` asked for one process's record: `name` is the four-word MIB, `info` receives the record and `size` its
 * length in bytes. Returns 0 when the kernel answers. */
export type KernelProcessQuery = (
  name: Int32Array,
  info: BigInt64Array,
  size: BigUint64Array,
) => number;

/** Reads start times through `query`. A refused query is PROCESS_INSPECT, never a process that is gone. */
export function kernelStartReader(
  query: KernelProcessQuery,
): ProcessStartReader {
  const name = new Int32Array([CTL_KERN, KERN_PROC, KERN_PROC_PID, 0]);
  const info = new BigInt64Array(KINFO_WORDS);
  const size = new BigUint64Array(1);
  return (pid) => {
    name[3] = pid;
    size[0] = BigInt(info.byteLength);
    if (query(name, info, size) !== 0)
      throw new RigError(
        "PROCESS_INSPECT",
        `sysctl could not read process ${pid}.`,
        "Check process inspection permissions before retrying.",
        { pid },
      );
    return size[0] === 0n ? undefined : Number(info[0]!);
  };
}

/** Pure: a start time as `ps -o lstart=` prints it under `LC_ALL=C TZ=UTC`, such as `Mon Oct 12 10:00:00 2026`. */
export function lstartText(seconds: number): string {
  const at = new Date(seconds * 1000);
  return `${DAYS[at.getUTCDay()]} ${MONTHS[at.getUTCMonth()]} ${String(at.getUTCDate()).padStart(2, " ")} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} ${at.getUTCFullYear()}`;
}
