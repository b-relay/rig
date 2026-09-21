import { useState } from "react";
import { KeyRound } from "lucide-react";
import { useApi } from "../hooks";
import { Failure } from "../ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Shown when the relay asks for the Host's access key; `onSignedIn` re-reads everything. */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const api = useApi();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  return (
    <Card className="mx-auto mt-8 w-full max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-5" /> Sign in to this Host
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(undefined);
            api
              .signIn(key.trim())
              .then(onSignedIn, setError)
              .finally(() => setBusy(false));
          }}
        >
          <p className="text-sm text-muted-foreground">
            This browser is not on the Mac that runs rigd, so it needs the
            Host&apos;s access key. The web Service&apos;s log names the file
            that holds it.
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor="access-key">Access key</Label>
            <Input
              id="access-key"
              type="password"
              autoComplete="current-password"
              className="font-mono"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </div>
          <Failure error={error} />
          <Button type="submit" disabled={busy || key.trim() === ""}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
