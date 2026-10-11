"use client";

import { useEffect, useRef, useState } from "react";
import { monogram, projectColor } from "@/lib/health";
import { cn } from "@/lib/utils";

const COLOR = {
  1: "bg-chart-1",
  2: "bg-chart-2",
  3: "bg-chart-3",
  4: "bg-chart-4",
  5: "bg-chart-5",
} as const;
const SIZE = {
  sm: "size-5 rounded-md text-[9px]",
  md: "size-9 rounded-lg text-sm",
  lg: "size-11 rounded-xl text-base",
} as const;
const IMAGE = { sm: "size-3.5", md: "size-5", lg: "size-6" } as const;

/** A Project's icon: its published site's favicon once one has loaded, otherwise its two letters
 * in Space Grotesk on the Project's own chart colour. The monogram shows first, so a Project
 * without a favicon never flashes an empty frame. */
export function ProjectIcon({
  project,
  favicon = false,
  size = "lg",
  className,
}: {
  project: string;
  /** Try the stable Target's favicon (`/project-icon`); only a Project with a published site has one. */
  favicon?: boolean;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  // An icon that finished loading before the page hydrated fired its load event unheard.
  useEffect(() => {
    if (image.current?.complete && image.current.naturalWidth > 0)
      setLoaded(true);
  }, []);
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden",
        SIZE[size],
        loaded
          ? "border bg-card shadow-xs"
          : cn(
              "font-display font-bold tracking-tight text-white shadow-xs",
              COLOR[projectColor(project)],
            ),
        className,
      )}
    >
      {loaded ? null : monogram(project)}
      {favicon ? (
        // eslint-disable-next-line @next/next/no-img-element -- a favicon of unknown size, served by /project-icon
        <img
          ref={image}
          src={`/project-icon?project=${encodeURIComponent(project)}`}
          alt=""
          className={cn(
            "object-contain",
            IMAGE[size],
            loaded ? "block" : "absolute size-0 opacity-0",
          )}
          onLoad={(event) => {
            if (event.currentTarget.naturalWidth > 0) setLoaded(true);
          }}
        />
      ) : null}
    </span>
  );
}
