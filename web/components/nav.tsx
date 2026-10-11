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
      className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t bg-background/90 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-md sm:hidden"
    >
      {SECTIONS.map(({ href, label, icon: Icon, ...rest }) => {
        const current = isCurrent(pathname, href, "exact" in rest);
        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "group flex flex-1 flex-col items-center gap-1 pt-2 pb-1.5 text-[11px] text-muted-foreground no-underline",
              current && "font-medium text-foreground",
            )}
          >
            <span
              className={cn(
                "flex h-7 w-12 items-center justify-center rounded-lg transition-colors",
                current && "bg-muted",
              )}
            >
              <Icon className="size-[18px]" aria-hidden />
            </span>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
