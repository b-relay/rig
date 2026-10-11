import Link from "next/link";
import { cn } from "@/lib/utils";

/** The site's mark and name: a monogram tile like a Project's, in the palette's ink, and an amber
 * tag when this copy drives a sandbox of its own. */
export function Brand({
  sandbox = false,
  className,
}: {
  sandbox?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <Link
        href="/"
        className="flex items-center gap-2 text-foreground no-underline"
      >
        <span
          aria-hidden
          className="flex size-7 items-center justify-center rounded-lg bg-primary font-display text-sm font-bold text-primary-foreground shadow-xs"
        >
          R
        </span>
        <span className="text-[15px] font-semibold tracking-tight">Rig</span>
      </Link>
      {sandbox ? (
        <span
          className="rounded-md bg-warn-fill px-1.5 py-0.5 text-[11px] font-medium text-warn"
          title="This copy drives a throwaway rigd of its own, seeded with demo Projects."
        >
          sandbox
        </span>
      ) : null}
    </span>
  );
}
