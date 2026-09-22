"use client";

import { Button } from "@/components/ui/button";

/** A page that could not render; the message is what the server let through. */
export default function PageError({
  error,
  reset,
}: {
  error: Error;
  reset(): void;
}) {
  return (
    <div className="flex flex-col gap-3 py-10">
      <h1 className="title text-2xl">This page did not render</h1>
      <p className="text-sm">{error.message}</p>
      <div>
        <Button variant="outline" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
