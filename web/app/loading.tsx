/** Shown the instant a section is tapped, until its server data arrives. */
export default function Loading() {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <span
        aria-hidden
        className="busy-dot inline-block size-2 rounded-full bg-busy"
      />
      Loading…
    </p>
  );
}
