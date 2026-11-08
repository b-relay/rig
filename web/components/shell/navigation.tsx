"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

/** The sidebar, rendered once: kept open beside the page on wide screens, and shown in a drawer on narrower ones, which
 * the top bar's `MenuButton` opens. The page's columns (`children`) sit inside, so that button can reach the drawer. The
 * drawer closes when a link is followed. */
export function Navigation({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <aside className="sticky top-0 hidden h-dvh border-r border-sidebar-border bg-sidebar lg:block">
        {sidebar}
      </aside>
      {children}
      <SheetContent
        side="left"
        className="w-72 border-sidebar-border bg-sidebar p-0"
        // A link to the page already shown changes no pathname, so any followed link closes the drawer.
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a")) setOpen(false);
        }}
      >
        <SheetTitle className="sr-only">Menu</SheetTitle>
        {sidebar}
      </SheetContent>
    </Sheet>
  );
}
/** Opens the sidebar's drawer, on screens too narrow to keep it open. It sits inside `Navigation`. */
export function MenuButton() {
  return (
    <SheetTrigger asChild>
      <button
        type="button"
        className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
        aria-label="Open the menu"
      >
        <Menu className="size-5" aria-hidden />
      </button>
    </SheetTrigger>
  );
}
