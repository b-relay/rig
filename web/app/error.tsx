"use client";

import { TriangleAlert } from "lucide-react";
import { CARD } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A page that could not render; the message is what the server let through. */
export default function PageError({
  error,
  reset,
}: {
  error: Error;
  reset(): void;
}) {
  return (
    <section
      className={cn(
        CARD,
        "mx-auto mt-6 flex w-full max-w-lg flex-col items-start gap-4 p-6",
      )}
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-bad-fill text-bad">
        <TriangleAlert className="size-5" aria-hidden />
      </span>
      <div>
        <h1 className="text-lg font-semibold tracking-tight">
          This page did not render
        </h1>
        <p className="mt-1 text-sm break-words text-muted-foreground">
          {error.message}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={reset}>
        Try again
      </Button>
    </section>
  );
}
