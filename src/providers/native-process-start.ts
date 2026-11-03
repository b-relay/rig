const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
const CTL_KERN = 1;
const KERN_PROC = 14;
const KERN_PROC_PID = 1;
/** `struct kinfo_proc` is 648 bytes and begins with the process's start time; the buffer is larger so a newer kernel's fits. */
const KINFO_WORDS = 256;

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

/** When a process started, in Unix seconds; undefined when no process has the pid. Throws when the kernel refuses to say. */
export type ProcessStartReader = (pid: number) => number | undefined;

let loaded: Promise<ProcessStartReader | undefined> | undefined;

/** Reads a process's start from the macOS kernel through `bun:ffi`: `sysctl(KERN_PROC_PID)`, the record `ps` itself reads,
 * so it answers for a zombie and for another user's process as `ps` does, and starts no process. `undefined` where the call
 * is unavailable (not macOS, or the library cannot be loaded); the caller then runs `ps`. Imported on first use, and past
 * the dashboard's bundler, which cannot resolve `bun:ffi`. */
export function nativeProcessStart(): Promise<ProcessStartReader | undefined> {
  loaded ??= load();
  return loaded;
}

async function load(): Promise<ProcessStartReader | undefined> {
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
    });
    const name = new Int32Array([CTL_KERN, KERN_PROC, KERN_PROC_PID, 0]);
    const info = new BigInt64Array(KINFO_WORDS);
    const size = new BigUint64Array(1);
    return (pid) => {
      name[3] = pid;
      size[0] = BigInt(info.byteLength);
      if (symbols.sysctl(ptr(name), 4, ptr(info), ptr(size), null, 0) !== 0)
        throw new Error(`sysctl could not read process ${pid}.`);
      return size[0] === 0n ? undefined : Number(info[0]!);
    };
  } catch {
    return undefined;
  }
}

/** Pure: a start time as `ps -o lstart=` prints it in the C locale, such as `Mon Oct 12 10:00:00 2026`, in the process's own
 * time zone or in UTC. */
export function lstartText(seconds: number, zone: "local" | "utc"): string {
  const at = new Date(seconds * 1000);
  const [day, month, date, year, hours, minutes, rest] =
    zone === "utc"
      ? [
          at.getUTCDay(),
          at.getUTCMonth(),
          at.getUTCDate(),
          at.getUTCFullYear(),
          at.getUTCHours(),
          at.getUTCMinutes(),
          at.getUTCSeconds(),
        ]
      : [
          at.getDay(),
          at.getMonth(),
          at.getDate(),
          at.getFullYear(),
          at.getHours(),
          at.getMinutes(),
          at.getSeconds(),
        ];
  return `${DAYS[day]} ${MONTHS[month]} ${String(date).padStart(2, " ")} ${two(hours)}:${two(minutes)}:${two(rest)} ${year}`;
}
