import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { daemon, read } from "@/server/daemon";
import { attempt } from "@/lib/outcome";
import type { Theme } from "@/lib/theme";
import type { DaemonHealth, QueueResult } from "@/lib/types";
import { LiveRefresh } from "./live-refresh";
import { MobileMenu } from "./shell/mobile-menu";
import { ThemeSwitch } from "./theme-switch";
import { cn } from "@/lib/utils";

/** The bar above every page: the menu on narrow screens, what rigd is doing right now, the live
 * refresh and the theme switch. `bare` keeps the wordmark alone, for a browser that has not signed
 * in and must learn nothing about this Mac. */
export function TopBar({
  bare = false,
  menu,
  theme,
}: {
  bare?: boolean;
  /** The sidebar, shown in a drawer below the width where it stays open. */
  menu?: ReactNode;
  theme: Theme | undefined;
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-rule bg-background/85 backdrop-blur-sm">
      <div className="flex h-12 items-center gap-2 px-4 sm:px-6 lg:px-8">
        {bare ? (
          <Link href="/" className="wordmark text-lg text-ink no-underline">
            RIG
          </Link>
        ) : (
          <>
            <MobileMenu>{menu}</MobileMenu>
            <Link
              href="/"
              className="wordmark text-lg text-ink no-underline lg:hidden"
            >
              RIG
            </Link>
            <div className="ml-auto flex items-center gap-1">
              <Suspense fallback={<DaemonMark state="probing" />}>
                <DaemonStatus />
              </Suspense>
              <LiveRefresh />
            </div>
          </>
        )}
        <ThemeSwitch initial={theme} className={bare ? "ml-auto" : undefined} />
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
      className="flex h-8 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground no-underline hover:bg-muted hover:text-foreground"
      title={detail ?? (state === "down" ? "rigd is not reachable" : "rigd")}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          state === "up" && "bg-good",
          state === "busy" && "busy-dot bg-busy",
          state === "down" && "bg-bad",
          state === "probing" && "bg-muted-ink",
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
