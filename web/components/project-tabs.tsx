"use client";

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
/** The sections of one Project, as a ruled row of links. */
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
  return (
    <nav
      aria-label={label}
      className="-mx-4 overflow-x-auto border-b border-rule px-4 sm:mx-0 sm:px-0"
    >
      <ul className="flex w-max gap-1">
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
                  "-mb-px block border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground no-underline hover:text-ink",
                  current && "border-ink font-medium text-ink",
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
