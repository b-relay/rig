import Link from "next/link";
import { MapPinOff } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <section className="mx-auto mt-6 flex w-full max-w-lg flex-col items-start gap-4 rounded-xl border border-dashed p-6">
      <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <MapPinOff className="size-5" aria-hidden />
      </span>
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Not here</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Nothing is served at this address.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/" className="text-foreground no-underline">
          Back to the overview
        </Link>
      </Button>
    </section>
  );
}
