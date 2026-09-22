"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { useOperationsInFlight } from "./operations";
import { cn } from "@/lib/utils";

const EVERY_MS = 15_000;
const BUSY_MS = 3_000;
/** Re-renders the page's server data on a timer while the tab is visible, and again the moment it
 * becomes visible; faster while this page has an Operation in flight. Client state (a log follow,
 * a half-typed form) survives, because only the server components are replaced. */
export function LiveRefresh() {
  const router = useRouter();
  const inFlight = useOperationsInFlight();
  const [pending, startTransition] = useTransition();
  const [refreshedAt, setRefreshedAt] = useState<number>();
  useEffect(() => {
    const refresh = () => {
      startTransition(() => router.refresh());
      setRefreshedAt(Date.now());
    };
    const timer = setInterval(
      () => {
        if (document.visibilityState === "visible") refresh();
      },
      inFlight > 0 ? BUSY_MS : EVERY_MS,
    );
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [router, inFlight]);
  return (
    <button
      type="button"
      onClick={() => {
        startTransition(() => router.refresh());
        setRefreshedAt(Date.now());
      }}
      className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs text-deck-muted hover:text-on-deck"
      title={
        refreshedAt
          ? `Refreshed ${new Date(refreshedAt).toLocaleTimeString()}`
          : "Refreshes every 15 s"
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
