/** Shown the instant a section is tapped, until its server data arrives: the shape of a page, in
 * quiet bars and card outlines. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading">
      <div className="flex flex-col gap-2">
        <div className="h-7 w-40 animate-pulse rounded-lg bg-muted" />
        <div className="h-4 w-72 max-w-full animate-pulse rounded-md bg-muted/70" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="h-28 animate-pulse rounded-xl border bg-muted/40"
          />
        ))}
      </div>
    </div>
  );
}
