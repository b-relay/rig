"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { projectHref, targetHref } from "@/lib/target";
import { cn } from "@/lib/utils";

const PROJECT_TABS = [
  ["", "Overview"],
  ["deployments", "Deployments"],
  ["logs", "Logs"],
  ["environment", "Environment"],
  ["jobs", "Jobs"],
  ["config", "Config"],
  ["activity", "Activity"],
  ["doctor", "Doctor"],
  ["settings", "Settings"],
] as const;
const TARGET_TABS = [
  ["", "Overview"],
  ["deployments", "Deployments"],
  ["logs", "Logs"],
  ["environment", "Environment"],
  ["jobs", "Jobs"],
] as const;
/** The sections of one Project, as a segmented row of links. */
export function ProjectTabs({ project }: { project: string }) {
  return (
    <SectionTabs
      base={projectHref(project)}
      tabs={PROJECT_TABS}
      label="Project sections"
    />
  );
}
/** The sections of one Target. */
export function TargetTabs({
  project,
  target,
}: {
  project: string;
  target: string;
}) {
  return (
    <SectionTabs
      base={targetHref(project, target)}
      tabs={TARGET_TABS}
      label="Target sections"
    />
  );
}
function SectionTabs({
  base,
  tabs,
  label,
}: {
  base: string;
  tabs: readonly (readonly [string, string])[];
  label: string;
}) {
  const pathname = decodeURIComponent(usePathname());
  const row = useRef<HTMLElement>(null);
  // On a phone the row scrolls sideways; the current tab is centred in it whenever it changes.
  // Only the row moves, never the page, so back and forward keep their scroll position.
  useEffect(() => {
    const nav = row.current;
    const tab = nav?.querySelector<HTMLElement>("[aria-current=page]");
    if (!nav || !tab || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollTo({
      left: tab.offsetLeft - (nav.clientWidth - tab.offsetWidth) / 2,
    });
  }, [pathname]);
  return (
    <nav
      ref={row}
      aria-label={label}
      className="no-scrollbar relative -mx-4 overflow-x-auto px-4 [mask-image:linear-gradient(to_right,transparent,black_1rem,black_calc(100%-1rem),transparent)] sm:mx-0 sm:px-0 sm:[mask-image:none]"
    >
      <ul className="flex w-max gap-0.5 rounded-xl border bg-muted/60 p-1">
        {tabs.map(([segment, text]) => {
          const href = segment ? `${base}/${segment}` : base;
          const current =
            pathname === decodeURIComponent(href) ||
            (segment !== "" &&
              pathname.startsWith(`${decodeURIComponent(href)}/`));
          return (
            <li key={segment}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex h-8 items-center rounded-lg px-3 text-sm font-medium whitespace-nowrap text-idle no-underline transition-colors hover:text-foreground",
                  current && "bg-card text-foreground shadow-xs",
                )}
              >
                {text}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
