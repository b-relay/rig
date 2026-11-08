import type { ManagedComponent } from "../config/types";
import { isHealthUrl } from "../config/schema";
import type { TargetRecord } from "../domain/runtime";
import type {
  CommandResult,
  CommandRunner,
  HealthCheck,
  Supervisor,
} from "../providers/contracts";
import type { ListenerInspection } from "../providers/listener-inspection";
import type { PortProbe } from "../providers/port-probe";
import { declaredPorts, plannedRoutes } from "../runtime/ports";
import { ownedListeners } from "../runtime/lifecycle";
import type { HealthObservation } from "../runtime/status";
import {
  failureReason as describedFailure,
  lastOutputLine,
} from "../domain/errors";
import { keepRecent } from "../domain/recent-entries";
import { redactValues } from "../domain/redaction";
import { privateDirectoryWithin } from "../providers/private-files";
import {
  runDirectory,
  type InvocationEnvironment,
} from "./invocation-environment";
import type { TargetOutput } from "./target-output";

/** How many Target Components' health evidence is remembered: more than the Services a Mac runs at once. */
const KEPT_HEALTH_EVIDENCE = 1024;

/** A Service's health checks, each answer recorded in the Target log as evidence when it changes. */
export interface TargetHealth {
  /** The start gate's check: the Service's own check, or without one a connection to every port it declares. */
  health(
    component: ManagedComponent,
    target: TargetRecord,
    signal: AbortSignal,
  ): Promise<HealthObservation>;
  /** An ongoing check, as status and the health monitor run it: the start gate's check, except that a check of the Service's
   * ports, and any check of a routed Service, passes only on listeners its own running process owns, so a program that took
   * a port it left never answers for it. */
  ongoingHealth(
    component: ManagedComponent,
    target: TargetRecord,
    signal: AbortSignal,
  ): Promise<HealthObservation>;
}
/** Health checks through `run` (a shell check, in an environment from `environment`), `connect` (ports) and the global
 * fetch (a URL check), with listeners read through `listeners` and the Service's process observed through its
 * `supervisor`. */
export function createTargetHealth(options: {
  run: CommandRunner;
  connect: PortProbe;
  listeners: ListenerInspection;
  environment: Pick<InvocationEnvironment, "compose">;
  output: Pick<TargetOutput, "recordLines">;
  supervisor: (target: TargetRecord) => Supervisor;
}): TargetHealth {
  /** Last recorded probe evidence per Target Component, so the Target log holds each change rather than every poll. Only
   * the most recently checked are kept: a destroyed Preview or a removed Service is never checked again, so its entry goes
   * in time. */
  const lastHealth = new Map<string, string>();
  /** A check's answer, whatever becomes of its evidence: evidence that cannot be written is said (`unrecorded`) and stays
   * unrecorded, so the next check writes it. Evidence whose Target directory is gone is dropped, as is the memory of it: a
   * check still in flight as its Preview is destroyed must not bring back what was deleted, and no one is left to tell. */
  const evidenced = async (
    check: HealthCheck,
    component: ManagedComponent,
    target: TargetRecord,
  ): Promise<HealthObservation> => {
    const evidence = check.ready ? "ready" : check.reason;
    const key = `${target.id}:${component.name}`;
    if (lastHealth.get(key) !== evidence)
      try {
        await options.output.recordLines(
          target,
          component.name,
          "health",
          [evidence],
          privateDirectoryWithin,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return check;
        return { ...check, unrecorded: describedFailure(error) };
      }
    keepRecent(lastHealth, key, evidence, KEPT_HEALTH_EVIDENCE);
    return check;
  };
  /** Without a check of its own a Service is ready once every port it declares accepts a connection. */
  const connections = async (
    component: ManagedComponent,
    signal: AbortSignal,
  ): Promise<HealthCheck> => {
    const ports = Object.entries(declaredPorts(component));
    if (!ports.length) return { ready: false, reason: "no health check" };
    for (const [name, port] of ports) {
      const check = await options.connect(port, signal);
      if (!check.ready)
        return { ready: false, reason: `${name}: ${check.reason}` };
    }
    return { ready: true };
  };
  /** An HTTP answer below 400, a redirect included, means the process is serving; a shell probe passes on exit 0 within the
   * healthcheck's timeout, or 2 s for a `ready` check a plan recorded before healthcheck. */
  const probe = async (
    component: ManagedComponent,
    target: TargetRecord,
    signal: AbortSignal,
  ): Promise<HealthCheck> => {
    const timeoutMs = (component.healthcheck?.timeout ?? 2) * 1000;
    try {
      if (isHealthUrl(component.health!))
        return await urlCheck(component, timeoutMs, signal);
      const { env, secrets } = await options.environment.compose(
        target,
        component,
        [],
        true,
      );
      const result = await options.run({
        command: ["/bin/sh", "-c", component.health!],
        cwd: await runDirectory(target, component),
        env,
        signal,
        timeoutMs,
      });
      if (result.exitCode === 0) return { ready: true };
      const detail = healthOutput(result, secrets);
      return {
        ready: false,
        reason: `${result.timedOut ? `timed out after ${timeoutMs / 1000}s` : `exit code ${result.exitCode}`}${detail ? `: ${detail}` : ""}`,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return { ready: false, reason: failureReason(error) };
    }
  };
  const health: TargetHealth["health"] = async (component, target, signal) =>
    await evidenced(
      component.health
        ? await probe(component, target, signal)
        : await connections(component, signal),
      component,
      target,
    );
  return {
    health,
    async ongoingHealth(component, target, signal) {
      const routed = plannedRoutes(target.plan).some(
        (route) => route.service === component.name,
      );
      if (component.health && !routed)
        return await health(component, target, signal);
      const reached = component.health
        ? await probe(component, target, signal)
        : await connections(component, signal);
      const owned = reached.ready
        ? await ownedListeners(
            component,
            target,
            {
              listeners: (pid, inspecting) =>
                options.listeners.inspect(pid, inspecting),
            },
            {
              observe: () =>
                options
                  .supervisor(target)
                  .observe(`${target.id}:${component.name}`, signal),
            },
            signal,
          ).catch((error: unknown): HealthCheck => ({
            ready: false,
            reason: describedFailure(error),
          }))
        : reached;
      return await evidenced(owned, component, target);
    },
  };
}
/** A healthcheck's timeout bounds each request, at start and while it runs; a `ready` URL a plan recorded before
 * healthcheck is bounded by its start budget alone, as it was. The request has its own signal, aborted by the caller's or
 * by its timer; both are let go when it ends, so a finished check holds no timer and no listener. */
async function urlCheck(
  component: ManagedComponent,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<HealthCheck> {
  const request = new AbortController();
  let timedOut = false;
  const forward = () => request.abort(signal.reason);
  signal.addEventListener("abort", forward, { once: true });
  const timer = component.healthcheck
    ? setTimeout(() => {
        timedOut = true;
        request.abort();
      }, timeoutMs)
    : undefined;
  try {
    if (signal.aborted) forward();
    const response = await fetch(component.health!, {
      signal: request.signal,
      redirect: "manual",
    });
    await response.body?.cancel();
    return response.status < 400
      ? { ready: true }
      : { ready: false, reason: `HTTP ${response.status}` };
  } catch (error) {
    if (!signal.aborted && timedOut)
      return {
        ready: false,
        reason: `timed out after ${timeoutMs / 1000}s`,
      };
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", forward);
  }
}
/** A failed health command's last non-empty output line, stderr first, cut to fit one log line, since it is shown in status,
 * Activity and errors. Every env-file value is redacted in the output as printed, before a line is picked, trimmed or cut,
 * and a line the runner kept only part of is left out; undefined when nothing whole is left. */
export function healthOutput(
  result: CommandResult,
  secrets: readonly string[],
): string | undefined {
  // A stream the runner cut starts partway through a line, maybe partway through a value; that line is left out.
  const whole = (stream: "stdout" | "stderr") => {
    const text = result[stream];
    if (!result.truncated?.[stream]) return text;
    const start = text.indexOf("\n");
    return start === -1 ? "" : text.slice(start + 1);
  };
  const line =
    lastOutputLine(redactValues(whole("stderr"), secrets)) ??
    lastOutputLine(redactValues(whole("stdout"), secrets));
  return line?.slice(0, 160);
}
/** A probe transport failure named by its error code when it has one, else its message. */
export function failureReason(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code ? code : error.message;
  }
  return String(error);
}
