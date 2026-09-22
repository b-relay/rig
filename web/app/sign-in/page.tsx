import type { Metadata } from "next";
import { SignInForm } from "./form";

export const metadata: Metadata = { title: "Sign in" };
/** Shown in place of any page to a browser beyond this Mac that has no session yet. */
export default function SignInPage() {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 py-10">
      <div>
        <h1 className="title text-2xl">Sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This dashboard controls the Mac that serves it. Paste its access key.
        </p>
      </div>
      <SignInForm />
      <p className="text-xs text-muted-foreground">
        On that Mac, the web Service's log names the key file:{" "}
        <code>rig logs live --project rig</code>.
      </p>
    </div>
  );
}
