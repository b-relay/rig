"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  ["", "Targets"],
  ["deploy", "Deploy"],
  ["logs", "Logs"],
  ["activity", "Activity"],
  ["config", "Config"],
  ["recipes", "Recipes"],
  ["doctor", "Doctor"],
  ["settings", "Settings"],
] as const;
/** The sections of one Project, as a ruled row of links. */
export function ProjectTabs({ project }: { project: string }) {
  const pathname = usePathname();
  const base = `/projects/${encodeURIComponent(project)}`;
  return (
    <nav
      aria-label="Project sections"
      className="-mx-4 overflow-x-auto border-b border-rule px-4 sm:mx-0 sm:px-0"
    >
      <ul className="flex w-max gap-1">
        {TABS.map(([segment, label]) => {
          const href = segment ? `${base}/${segment}` : base;
          const current = pathname === href;
          return (
            <li key={segment}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "-mb-px block border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground no-underline hover:text-ink",
                  current && "border-ink text-ink",
                )}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
