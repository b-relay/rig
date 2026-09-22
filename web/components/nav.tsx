"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, LayoutList, Plus, Server, Stethoscope } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/", label: "Board", icon: LayoutList },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/doctor", label: "Doctor", icon: Stethoscope },
  { href: "/rigd", label: "rigd", icon: Server },
  { href: "/projects/new", label: "Add", icon: Plus },
] as const;
const active = (pathname: string, href: string) =>
  href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(`${href}/`);

/** The top bar's links, on screens wide enough for words. */
export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav aria-label="Sections" className="hidden items-center gap-1 sm:flex">
      {ITEMS.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          aria-current={active(pathname, href) ? "page" : undefined}
          className={cn(
            "rounded px-2.5 py-1 text-sm text-deck-muted no-underline hover:text-on-deck",
            active(pathname, href) && "bg-on-deck/10 text-on-deck",
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
/** The same sections as icons along the bottom of a phone screen, where a thumb reaches. */
export function BottomTabs() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-on-deck/10 bg-deck pb-[env(safe-area-inset-bottom)] text-on-deck sm:hidden"
    >
      {ITEMS.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={active(pathname, href) ? "page" : undefined}
          className={cn(
            "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] text-deck-muted no-underline",
            active(pathname, href) && "text-on-deck",
          )}
        >
          <Icon className="size-5" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}
