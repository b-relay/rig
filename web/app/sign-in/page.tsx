import type { Metadata } from "next";
import { Suspense } from "react";
import { KeyRound } from "lucide-react";
import { CARD } from "@/components/bits";
import { cn } from "@/lib/utils";
import { SignInForm } from "./form";

export const metadata: Metadata = { title: "Sign in" };
/** Shown in place of any page to a browser beyond this Mac that has no session yet. */
export default function SignInPage() {
  return (
    <div className="flex flex-col gap-4">
      <section className={cn(CARD, "flex flex-col gap-6 p-6")}>
        <div className="flex flex-col gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <KeyRound className="size-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              This dashboard controls the Mac that serves it. Paste its access
              key.
            </p>
          </div>
        </div>
        <Suspense>
          <SignInForm />
        </Suspense>
      </section>
      <p className="px-1 text-xs text-muted-foreground">
        On that Mac, the web Service&apos;s log names the key file:{" "}
        <code>rig logs stable --project rig</code>.
      </p>
    </div>
  );
}
