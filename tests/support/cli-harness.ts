import { runRigCli } from "../../src/cli/rig";
import type { CliDependencies, UserOutput } from "../../src/cli/types";
import type { RuntimeCommand } from "../../src/daemon/protocol";
import type {
  ProjectStatusReport,
  StatusSelection,
} from "../../src/domain/project-status";
import type {
  DiagnosticEntry,
  DiagnosticLog,
} from "../../src/diagnostics/types";

/** Where the harness's diagnostic log is said to be, for a scenario whose failures name it. */
export const DIAGNOSTIC_LOG = "/isolated/.rig/logs/rig/rig.jsonl";
/** A diagnostic record answer that names DIAGNOSTIC_LOG as the file it went to. */
export const recordedInLog: DiagnosticLog["record"] = async () => ({
  path: DIAGNOSTIC_LOG,
});

/** What a scenario supplies; the rest is the in-memory baseline. Any CliDependencies capability may be given as is
 * (`signal`, `detach`, `wait`, `now`, `interaction`, `outputTerminal`, ...); a wait resolves at once when none is. */
export interface CliHarnessOptions extends Partial<
  Omit<CliDependencies, "client" | "output" | "diagnostics" | "newOperationId">
> {
  /** rigd's answer to each command, as a value, a promise, or a throw. Absent, a command fails the test's run. */
  command?: (request: RuntimeCommand, signal?: AbortSignal) => unknown;
  /** rigd's status report. Absent, a status read fails the test's run. */
  status?: (
    selection: StatusSelection,
    signal?: AbortSignal,
  ) => ProjectStatusReport | Promise<ProjectStatusReport>;
  /** What recording a diagnostic answers, once the harness collected it: no file, when absent. */
  record?: DiagnosticLog["record"];
  /** Also sees each text after the harness captured it, such as a terminal emulator or a script acting on what was shown.
   * A write's answer is returned to the CLI, so a slow reader can be modelled. */
  output?: Partial<UserOutput>;
  /** The id every Operation gets; op-1 when absent. */
  operationId?: string;
}

/** An injected `rig` CLI with no daemon, filesystem or terminal: an isolated root and cwd that are never touched, every
 * request and diagnostic collected in order, and stdout and stderr captured apart and together. */
export function cliHarness(options: CliHarnessOptions = {}) {
  const {
    command,
    status,
    record,
    output,
    operationId = "op-1",
    ...capabilities
  } = options;
  const requests: RuntimeCommand[] = [];
  const events: DiagnosticEntry[] = [];
  let out = "";
  let err = "";
  let text = "";
  const deps: CliDependencies = {
    root: "/isolated/.rig",
    cwd: "/workspace",
    wait: async () => {},
    ...capabilities,
    client: {
      status(selection, signal) {
        requests.push({ ...selection, action: "status" });
        return answer(() => {
          if (!status) throw new Error("Unexpected status read");
          return status(selection, signal);
        });
      },
      command(request, signal) {
        requests.push(request);
        return answer(() => {
          if (!command) throw new Error("Unexpected daemon request");
          return command(request, signal);
        });
      },
    },
    output: {
      write(value) {
        out += value;
        text += value;
        return output?.write?.(value);
      },
      error(value) {
        err += value;
        text += value;
        return output?.error?.(value);
      },
    },
    diagnostics: {
      record(entry) {
        events.push(entry);
        return record ? record(entry) : Promise.resolve({});
      },
    },
    newOperationId: () => operationId,
  };
  return {
    deps,
    run: (args: readonly string[]) => runRigCli(args, deps),
    /** Every command sent and status read, in order; a status read is recorded with action `status`. */
    requests,
    /** Every diagnostic entry recorded, in order. */
    events,
    out: () => out,
    err: () => err,
    /** stdout and stderr as one transcript, in the order written. */
    text: () => text,
    /** Forgets the output captured so far, between two runs. */
    clear() {
      out = err = text = "";
    },
  };
}

/** A reply as the promise a client answers, settling as an async function returning it would: a thrown error rejects. */
function answer<T>(reply: () => T | Promise<T>): Promise<T> {
  try {
    const value = reply();
    return value instanceof Promise ? value : Promise.resolve(value);
  } catch (error) {
    return Promise.reject(error);
  }
}
