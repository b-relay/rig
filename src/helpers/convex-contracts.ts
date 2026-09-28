import type { UserOutput } from "../cli/types";
import type { CommandRunner } from "../providers/contracts";

/** Convex's backend releases and the binary cache `convex dev` shares (`~/.cache/convex/binaries/<release>`). */
export interface ConvexBackendReleases {
  /** The release Convex recommends now; undefined when it cannot be asked (offline) or gives no usable answer. */
  recommended(signal: AbortSignal): Promise<string | undefined>;
  /** Releases whose binary is already in the cache, in no particular order. */
  cached(): Promise<string[]>;
  /** The cached binary of `release`, downloaded into the cache first when it is missing. Throws CONVEX_BACKEND_DOWNLOAD
   * when it can be neither found nor downloaded, and CONVEX_PLATFORM on a platform Convex builds no backend for. */
  binary(release: string, signal: AbortSignal): Promise<string>;
}
/** How a child ended: by itself with a code, by a signal, or never started at all. */
export type ChildExit =
  | { readonly code: number }
  | { readonly signal: string }
  | { readonly startError: string };
/** One long-running child process. */
export interface RunningChild {
  /** Settles once, when the child has ended; never rejects. */
  readonly exited: Promise<ChildExit>;
  /** Asks the child to stop with SIGTERM; nothing once it has ended. */
  stop(): void;
}
/** Starts children that stay in this process's group and write to its stdout and stderr, so their output reaches the
 * Target log and a stop of the Service's process group reaches them too. */
export interface ChildProcesses {
  start(request: {
    readonly command: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  }): RunningChild;
}
/** The files one deployment and its workspace keep. Paths are absolute. */
export interface DeploymentFiles {
  /** The file's text; undefined when there is no such file. */
  read(path: string): Promise<string | undefined>;
  /** Replaces the file with text only its owner can read (mode 600), creating its directory (mode 700) first. */
  writePrivate(path: string, text: string): Promise<void>;
  /** Copies a directory tree to `to`, which must not exist yet. */
  copyDirectory(from: string, to: string): Promise<void>;
  /** Creates the directory (mode 700) and its parents when missing. */
  ensureDirectory(path: string): Promise<void>;
}
/** What `rigd convex` needs from outside itself. The entrypoint owns every one of them. */
export interface ConvexHelperDependencies {
  releases: ConvexBackendReleases;
  children: ChildProcesses;
  files: DeploymentFiles;
  /** Runs the backend's `keygen`, a short command. */
  run: CommandRunner;
  /** The text a loopback HTTP GET answers with a 2xx status; undefined when nothing answers or the status is another. */
  probe(url: string, signal: AbortSignal): Promise<string | undefined>;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  wait(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  /** A new deployment's instance secret: 32 random bytes as hex, as `convex dev --local` makes it. */
  newInstanceSecret(): string;
  output: UserOutput;
}
