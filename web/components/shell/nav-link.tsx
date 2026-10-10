"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Pure: whether `href` is the page shown, or (unless `exact`) one of its sub-pages. */
export function isCurrent(pathname: string, href: string, exact = false) {
  if (href === "/" || exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
/** A sidebar link that marks itself as the current page. */
export function NavLink({
  href,
  exact = false,
  className,
  activeClassName,
  children,
  title,
}: {
  href: string;
  exact?: boolean;
  className?: string;
  activeClassName?: string;
  children: ReactNode;
  title?: string;
}) {
  const pathname = usePathname();
  const current = isCurrent(pathname, href, exact);
  return (
    <Link
      href={href}
      title={title}
      aria-current={current ? "page" : undefined}
      className={cn(className, current && activeClassName)}
    >
      {children}
    </Link>
  );
}
