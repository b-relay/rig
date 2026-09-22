"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { Failure, Outcome } from "@/lib/outcome";
import { resolveSettlement, transportFailure } from "@/lib/reconcile";
import type { OperationResult, RuntimeCommand } from "@/lib/types";
import { runCommand, settleOperation } from "@/server/actions";

/** How many Operations pages have in flight right now, so the live refresh can quicken while one runs. */
let inFlight = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const useOperationsInFlight = (): number =>
  useSyncExternalStore(
    subscribe,
    () => inFlight,
    () => 0,
  );

const SETTLE_EVERY_MS = 2000;
const SETTLE_FOR_MS = 120_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** When the reply to a mutation never arrives, rigd still finishes it; the page asks where it
 * stands until it is recorded, rather than declaring a failure the Host never had. */
async function reconcile(
  command: RuntimeCommand & { operationId: string },
  error: unknown,
): Promise<Outcome<OperationResult>> {
  const transport = transportFailure(error);
  const deadline = Date.now() + SETTLE_FOR_MS;
  while (Date.now() < deadline) {
    await sleep(SETTLE_EVERY_MS);
    const settled = await settleOperation(command.operationId).catch(
      () => undefined,
    );
    if (!settled) continue;
    if (!settled.ok) return settled;
    const resolved = resolveSettlement(
      settled.value,
      {
        operationId: command.operationId,
        action: command.action,
        ...(command.project ? { project: command.project } : {}),
        ...(command.target ? { target: command.target } : {}),
      },
      transport.message,
    );
    if (resolved) return resolved;
  }
  return {
    ok: false,
    failure: { ...transport, operationId: command.operationId },
  };
}
export interface Run<T> {
  busy: boolean;
  failure?: Failure;
  result?: T;
  /** Sends one command with a fresh Operation id; answers the reply, or `undefined` after a shown failure. */
  run(command: RuntimeCommand): Promise<T | undefined>;
  clear(): void;
}
/** One user-started command at a time. Its refusal is kept for display, never thrown; a lost
 * reply is reconciled against rigd's record; every outcome refreshes the page's server data. */
export function useRun<T = OperationResult>(
  options: { refresh?: boolean } = {},
): Run<T> {
  const router = useRouter();
  const refresh = options.refresh ?? true;
  const [state, setState] = useState<{
    busy: boolean;
    failure?: Failure;
    result?: T;
  }>({
    busy: false,
  });
  const latest = useRef(0);
  const run = useCallback(
    async (command: RuntimeCommand) => {
      const turn = ++latest.current;
      const sent = {
        ...command,
        operationId: command.operationId ?? crypto.randomUUID(),
      };
      setState({ busy: true });
      inFlight += 1;
      notify();
      let outcome: Outcome<unknown>;
      try {
        outcome = await runCommand(sent);
      } catch (error) {
        outcome = await reconcile(sent, error);
      } finally {
        inFlight -= 1;
        notify();
      }
      if (turn !== latest.current) return undefined;
      if (outcome.ok) setState({ busy: false, result: outcome.value as T });
      else setState({ busy: false, failure: outcome.failure });
      if (refresh) router.refresh();
      return outcome.ok ? (outcome.value as T) : undefined;
    },
    [router, refresh],
  );
  const clear = useCallback(() => setState({ busy: false }), []);
  return {
    busy: state.busy,
    failure: state.failure,
    result: state.result,
    run,
    clear,
  };
}
