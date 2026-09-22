import Link from "next/link";
import { Suspense } from "react";
import { daemon, read } from "@/server/daemon";
import { attempt } from "@/lib/outcome";
import type { DaemonHealth, QueueResult } from "@/lib/types";
import { LiveRefresh } from "./live-refresh";
import { NavLinks } from "./nav";
import { cn } from "@/lib/utils";

/** The deck: wordmark, sections, and what rigd is doing right now. */
export function TopBar() {
  return (
    <header className="sticky top-0 z-20 bg-deck text-on-deck">
      <div className="mx-auto flex h-12 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="wordmark text-lg text-on-deck no-underline">
          RIG
        </Link>
        <NavLinks />
        <div className="ml-auto flex items-center gap-3">
          <Suspense fallback={<DaemonMark state="probing" />}>
            <DaemonStatus />
          </Suspense>
          <LiveRefresh />
        </div>
      </div>
    </header>
  );
}
async function DaemonStatus() {
  const [health, queue] = await Promise.all([
    attempt(daemon().then((client) => client.health())),
    attempt(read({ action: "queue" })),
  ]);
  if (!health.ok)
    return <DaemonMark state="down" detail={health.failure.message} />;
  const running = queue.ok ? (queue.value as QueueResult).running : undefined;
  return (
    <DaemonMark
      state={running ? "busy" : "up"}
      version={(health.value as DaemonHealth).version}
      detail={
        running
          ? [running.action, running.project, running.target]
              .filter(Boolean)
              .join(" ")
          : undefined
      }
    />
  );
}
function DaemonMark({
  state,
  version,
  detail,
}: {
  state: "probing" | "up" | "busy" | "down";
  version?: string;
  detail?: string;
}) {
  return (
    <Link
      href="/rigd"
      className="flex items-center gap-2 text-xs text-deck-muted no-underline hover:text-on-deck"
      title={detail ?? (state === "down" ? "rigd is not reachable" : "rigd")}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          state === "up" && "bg-good",
          state === "busy" && "bg-busy busy-dot",
          state === "down" && "bg-bad",
          state === "probing" && "bg-deck-muted",
        )}
      />
      <span className="hidden md:inline">
        {state === "down"
          ? "rigd unreachable"
          : state === "probing"
            ? "rigd"
            : detail
              ? `rigd · ${detail}`
              : `rigd${version ? ` ${version}` : ""}`}
      </span>
      <span className="sr-only">
        {state === "down"
          ? "rigd unreachable"
          : state === "busy"
            ? `rigd running ${detail}`
            : "rigd up"}
      </span>
    </Link>
  );
}
