"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isCurrent } from "./shell/nav-link";
import { SECTIONS } from "./shell/sections";
import { cn } from "@/lib/utils";

/** The Host-wide sections as icons along the bottom of a phone screen, where a thumb reaches.
 * Projects and their Targets are in the menu the top bar opens. */
export function BottomTabs() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-rule bg-sheet pb-[env(safe-area-inset-bottom)] sm:hidden"
    >
      {SECTIONS.map(({ href, label, icon: Icon, ...rest }) => {
        const current = isCurrent(pathname, href, "exact" in rest);
        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] text-muted-foreground no-underline",
              current && "text-foreground",
            )}
          >
            <Icon className="size-5" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
