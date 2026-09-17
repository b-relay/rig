import type {
  ListenerEvidence,
  ListenerInspection,
} from "../../src/providers/listener-inspection";
import type { PortProbe } from "../../src/providers/port-probe";

/** Every port answers, and the owned process listens on `ports` at loopback: activation evidence for a test about something else. */
export function localActivation(ports: readonly number[] = []): {
  connect: PortProbe;
  listeners: ListenerInspection;
} {
  return {
    connect: async () => ({ ready: true }),
    listeners: { inspect: async (pid) => loopbackListeners(pid, ports) },
  };
}
export function loopbackListeners(
  pid: number,
  ports: readonly number[],
): ListenerEvidence {
  return {
    state: "observed",
    listeners: ports.map((port) => ({ pid, address: "127.0.0.1", port })),
  };
}
