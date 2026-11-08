import Link from "@/components/link";
import { Suspense } from "react";
import { pagePulse } from "@/server/pulse";
import { rigdAway } from "@/lib/pulse";
import type { Theme } from "@/lib/theme";
import { LiveRefresh } from "./live-refresh";
import { Brand } from "./shell/brand";
import { MenuButton } from "./shell/navigation";
import { ThemeSwitch } from "./theme-switch";
import { cn } from "@/lib/utils";

/** The bar above every page: the menu on narrow screens, what rigd is doing right now, the live
 * refresh and the theme switch. `bare` keeps the mark alone, for a browser that has not signed
 * in and must learn nothing about this Mac. */
export function TopBar({
  bare = false,
  theme,
}: {
  bare?: boolean;
  theme: Theme | undefined;
}) {
  return (
    <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur-md">
      <div className="flex h-12 items-center gap-2 px-4 sm:px-6 lg:px-8">
        {bare ? (
          <Brand />
        ) : (
          <>
            <MenuButton />
            <Brand className="lg:hidden" />
            <div className="ml-auto flex items-center gap-1">
              <LiveRefresh
                status={
                  <Suspense fallback={<DaemonMark state="probing" />}>
                    <DaemonStatus />
                  </Suspense>
                }
              />
            </div>
          </>
        )}
        <ThemeSwitch initial={theme} className={bare ? "ml-auto" : undefined} />
      </div>
    </header>
  );
}
export async function DaemonStatus() {
  // The page's pulse: the same reads the sidebar keeps its Project statuses under, and any /pulse asking now shares.
  const { health, queue } = (await pagePulse()).readings;
  if (!health.ok)
    return (
      <DaemonMark
        state="down"
        detail={[health.failure.message, health.failure.hint]
          .filter(Boolean)
          .join(" ")}
        {...(!rigdAway(health.failure.code) && { fault: health.failure.code })}
      />
    );
  const running = queue.ok ? queue.value.running : undefined;
  return (
    <DaemonMark
      state={running ? "busy" : "up"}
      version={health.value.version}
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
  fault,
}: {
  state: "probing" | "up" | "busy" | "down";
  version?: string;
  detail?: string;
  /** The code of a failure that is not rigd being away. Monitor, where this links, says it in full with its hint. */
  fault?: string;
}) {
  const down = fault ? `rigd: ${fault}` : "rigd unreachable";
  return (
    <Link
      href="/monitor"
      className="flex h-8 items-center gap-2 rounded-lg px-2 text-xs text-muted-foreground no-underline hover:bg-muted hover:text-foreground"
      title={detail ?? (state === "down" ? "rigd is not reachable" : "rigd")}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          state === "up" && "bg-good",
          state === "busy" && "busy-dot bg-busy",
          state === "down" && "bg-bad",
          state === "probing" && "bg-idle",
        )}
      />
      <span className="hidden md:inline">
        {state === "down"
          ? down
          : state === "probing"
            ? "rigd"
            : detail
              ? `rigd · ${detail}`
              : `rigd${version ? ` ${version}` : ""}`}
      </span>
      <span className="sr-only">
        {state === "down"
          ? down
          : state === "busy"
            ? `rigd running ${detail}`
            : "rigd up"}
      </span>
    </Link>
  );
}
