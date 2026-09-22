"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Failure as FailureShape } from "@/lib/outcome";
import { signIn } from "@/server/actions";
import { transportFailure } from "@/lib/reconcile";
import { Failure, Field } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SignInForm() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureShape>();
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setFailure(undefined);
        try {
          const outcome = await signIn(key);
          if (outcome.ok) {
            // The rewrite kept the URL the visitor asked for, so a refresh renders that page.
            router.refresh();
            return;
          }
          setFailure(outcome.failure);
        } catch (error) {
          setFailure(transportFailure(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Access key" htmlFor="access-key">
        <Input
          id="access-key"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
      </Field>
      <Failure failure={failure} />
      <div>
        <Button type="submit" disabled={busy || key.length === 0}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </div>
    </form>
  );
}
