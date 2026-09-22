"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, WifiOff } from "lucide-react";
import { z } from "zod";
import { useOperationsInFlight } from "./operations";
import { cn } from "@/lib/utils";

const EVERY_MS = 15_000;
const BUSY_MS = 3_000;
/** Even an unchanged stamp gets a redraw this often, for the few things rigd records nothing about. */
const AT_LEAST_EVERY_MS = 120_000;
const pulseSchema = z.object({ stamp: z.string(), busy: z.boolean() });
type Reach = "live" | "offline";
/** Keeps the page's server data current while the tab is visible. Every tick asks the site for
 * rigd's pulse: a small stamp that changes when rigd's record did. Only a changed stamp, a
 * running Operation, or a long quiet spell re-renders the server components, so client state
 * (a log follow, a half-typed form) survives and pages seen a moment ago come back at once.
 * When the site does not answer, that is said here, in the corner, and the page stays. */
export function LiveRefresh() {
  const router = useRouter();
  const inFlight = useOperationsInFlight();
  const [pending, startTransition] = useTransition();
  const [reach, setReach] = useState<Reach>("live");
  const [refreshedAt, setRefreshedAt] = useState<number>();
  const [failedAt, setFailedAt] = useState<number>();
  const stamp = useRef<string | undefined>(undefined);
  const redrawnAt = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const redraw = () => {
      redrawnAt.current = Date.now();
      startTransition(() => router.refresh());
      setRefreshedAt(Date.now());
    };
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      const pulse = await readPulse();
      if (cancelled) return;
      if (pulse === "unreachable") {
        setReach("offline");
        setFailedAt(Date.now());
        return;
      }
      setReach("live");
      if (pulse === "refused") return redraw();
      const changed = pulse.stamp !== stamp.current;
      stamp.current = pulse.stamp;
      const stale = Date.now() - redrawnAt.current > AT_LEAST_EVERY_MS;
      if (changed || pulse.busy || inFlight > 0 || stale) redraw();
    };
    const timer = setInterval(
      () => void tick(),
      inFlight > 0 ? BUSY_MS : EVERY_MS,
    );
    const visible = () => void tick();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", visible);
    const offline = () => setReach("offline");
    window.addEventListener("offline", offline);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", visible);
      window.removeEventListener("offline", offline);
    };
  }, [router, inFlight]);
  const at = (instant: number) => new Date(instant).toLocaleTimeString();
  if (reach === "offline")
    return (
      <span
        className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs text-warn"
        title={`The site did not answer${failedAt ? ` at ${at(failedAt)}` : ""}; trying again every ${EVERY_MS / 1000} s.`}
        role="status"
      >
        <WifiOff className="size-3.5" aria-hidden />
        <span className="hidden sm:inline">offline</span>
        <span className="sr-only">The site did not answer; trying again.</span>
      </span>
    );
  return (
    <button
      type="button"
      onClick={() => {
        redrawnAt.current = Date.now();
        startTransition(() => router.refresh());
        setRefreshedAt(Date.now());
      }}
      className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs text-deck-muted hover:text-on-deck"
      title={
        refreshedAt
          ? `Refreshed ${at(refreshedAt)}`
          : `Checks rigd every ${EVERY_MS / 1000} s`
      }
      aria-label="Refresh now"
    >
      <RefreshCw className={cn("size-3.5", pending && "animate-spin")} />
      <span className="hidden sm:inline">
        {pending ? "refreshing" : "live"}
      </span>
    </button>
  );
}
/** One pulse: the stamp, `refused` when the site answered but not with one (the session
 * ended, most likely), or `unreachable` when nothing answered at all. */
async function readPulse(): Promise<
  z.infer<typeof pulseSchema> | "refused" | "unreachable"
> {
  let response: Response;
  try {
    response = await fetch("/pulse", { cache: "no-store" });
  } catch {
    return "unreachable";
  }
  if (!response.ok) return "refused";
  const parsed = pulseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : "refused";
}
