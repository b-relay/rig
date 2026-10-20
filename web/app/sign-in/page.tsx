import type { Metadata } from "next";
import { headers } from "next/headers";
import { Suspense } from "react";
import { KeyRound } from "lucide-react";
import { CARD } from "@/components/bits";
import { fromThisMac } from "@/server/guard";
import { site } from "@/server/site";
import { cn } from "@/lib/utils";
import { SignInForm } from "./form";

export const metadata: Metadata = { title: "Sign in" };
/** Shown under the published name in place of any page to a browser without a session (on the loopback address the
 * browser itself asks for the key). A browser on this Mac is shown the key file's exact path; one elsewhere only
 * where it lives. */
export default async function SignInPage() {
  const keyFile = fromThisMac((await headers()).get("x-forwarded-for"))
    ? site().keyFile
    : undefined;
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
      {keyFile ? (
        <p className="px-1 text-xs break-all text-muted-foreground">
          This dashboard&apos;s key is in <code>{keyFile}</code>. Read it on
          this Mac with <code>cat {keyFile}</code>.
        </p>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">
          On that Mac, the dashboard that comes with Rig keeps its key in{" "}
          <code>&lt;RIG_ROOT&gt;/auth/dashboard.key</code> (
          <code>~/.rig/auth/dashboard.key</code> by default); a working copy or
          Preview names its own in its log (<code>rig logs</code>).
        </p>
      )}
    </div>
  );
}
