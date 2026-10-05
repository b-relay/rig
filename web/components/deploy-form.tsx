"use client";

import { useState } from "react";
import { Rocket } from "lucide-react";
import type { DeploymentContext } from "@/lib/types";
import { Facts, Failure, Field, OperationNotice } from "./bits";
import { useRun } from "./operations";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Mode = "stable" | "preview";
export function DeployForm({
  project,
  context,
}: {
  project: string;
  context: DeploymentContext;
}) {
  const act = useRun();
  // Only the Targets rig.yaml turns on are offered; rigd refuses an off one anyway.
  const modes = (["stable", "preview"] as const).filter(
    (each) => context.on[each],
  );
  const [mode, setMode] = useState<Mode>(modes[0] ?? "stable");
  const [branch, setBranch] = useState("");
  const [commit, setCommit] = useState("");
  const [deployment, setDeployment] = useState("");
  const [force, setForce] = useState(false);
  const [noUp, setNoUp] = useState(false);
  const submit = () => {
    const source = {
      ...(branch ? { branch } : {}),
      ...(commit ? { commit } : {}),
    };
    const options = { ...(force ? { force } : {}), ...(noUp ? { noUp } : {}) };
    void act.run({
      action: "deploy",
      project,
      target: mode,
      ...(mode === "preview" && deployment ? { deployment } : {}),
      ...source,
      ...options,
    });
  };
  if (!modes.length)
    return (
      <p className="text-sm text-muted-foreground">
        Neither the stable Target nor Previews are on. Add{" "}
        <code>stable: true</code> or <code>preview: true</code> under{" "}
        <code>targets</code> in rig.yaml to deploy.
      </p>
    );
  return (
    <div className="flex flex-col gap-5">
      <Facts
        items={[
          [
            "Production Branch",
            <code key="p">{context.productionBranch}</code>,
          ],
          [
            "Checked-out Branch",
            <code key="c">{context.currentBranch ?? "detached"}</code>,
          ],
        ]}
      />
      <Tabs value={mode} onValueChange={(next) => setMode(next as Mode)}>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList className="w-max">
            {modes.map((each) => (
              <TabsTrigger key={each} value={each}>
                {each}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>
      <form
        className="flex max-w-lg flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          label="Branch"
          htmlFor="deploy-branch"
          help={
            mode === "stable"
              ? "Defaults to the Production Branch."
              : "Defaults to the checked-out Branch."
          }
        >
          <Input
            id="deploy-branch"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder={
              mode === "stable"
                ? context.productionBranch
                : (context.currentBranch ?? "")
            }
          />
        </Field>
        <Field
          label="Commit"
          htmlFor="deploy-commit"
          help="Optional: defaults to the Branch head."
        >
          <Input
            id="deploy-commit"
            value={commit}
            className="font-mono text-xs"
            onChange={(event) => setCommit(event.target.value)}
          />
        </Field>
        {mode === "preview" ? (
          <Field
            label="Preview name"
            htmlFor="deploy-name"
            help="Optional: defaults to a name made from the Branch."
          >
            <Input
              id="deploy-name"
              value={deployment}
              pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
              onChange={(event) => setDeployment(event.target.value)}
            />
          </Field>
        ) : null}
        <div className="flex flex-col gap-2">
          <Label className="gap-2 font-normal">
            <Checkbox
              checked={force}
              onCheckedChange={(next) => setForce(next === true)}
            />
            Redeploy even when the Commit is unchanged
          </Label>
          <Label className="gap-2 font-normal">
            <Checkbox
              checked={noUp}
              onCheckedChange={(next) => setNoUp(next === true)}
            />
            Prepare only; do not start the Target
          </Label>
        </div>
        <div>
          <Button type="submit" disabled={act.busy}>
            <Rocket />
            {act.busy ? "Deploying…" : "Deploy"}
          </Button>
        </div>
      </form>
      <Failure failure={act.failure} />
      <OperationNotice result={act.result} />
    </div>
  );
}
