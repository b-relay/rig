"use client";

import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { nextTheme, themeCookie, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const LABEL = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};
/** Cycles system, light and dark. The choice is applied to the page at once and kept in a cookie,
 * so the next page the server renders is already in it. */
export function ThemeSwitch({
  initial,
  className,
}: {
  initial: Theme | undefined;
  className?: string;
}) {
  const [theme, setTheme] = useState<Theme | undefined>(initial);
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const label = LABEL[theme ?? "system"];
  return (
    <button
      type="button"
      title={`${label}; click to switch`}
      aria-label={`${label}; click to switch`}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
      onClick={() => {
        const next = nextTheme(theme);
        setTheme(next);
        document.cookie = themeCookie(next);
        const root = document.documentElement;
        if (next) root.dataset.theme = next;
        else delete root.dataset.theme;
      }}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
