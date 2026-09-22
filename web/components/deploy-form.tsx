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

type Mode = "stable" | "preview" | "push";
export function DeployForm({
  project,
  repoPath,
  context,
}: {
  project: string;
  repoPath: string;
  context: DeploymentContext;
}) {
  const act = useRun();
  const [mode, setMode] = useState<Mode>("stable");
  const [branch, setBranch] = useState("");
  const [commit, setCommit] = useState("");
  const [deployment, setDeployment] = useState("");
  const [force, setForce] = useState(false);
  const [noUp, setNoUp] = useState(false);
  const stable = context.targets.stable;
  const submit = () => {
    const source = {
      ...(branch ? { branch } : {}),
      ...(commit ? { commit } : {}),
    };
    const options = { ...(force ? { force } : {}), ...(noUp ? { noUp } : {}) };
    void act.run(
      mode === "push"
        ? { action: "git-push", project, repoPath, ...source }
        : {
            action: "deploy",
            project,
            target: mode === "stable" ? stable : "preview",
            ...(mode === "preview" && deployment ? { deployment } : {}),
            ...source,
            ...options,
          },
    );
  };
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
            <TabsTrigger value="stable">Stable ({stable})</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="push">By Branch role</TabsTrigger>
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
              : mode === "preview"
                ? "Defaults to the checked-out Branch."
                : "The Production Branch deploys the Stable Target; any other Branch deploys a Preview, as git push rig does."
          }
        >
          <Input
            id="deploy-branch"
            value={branch}
            required={mode === "push"}
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
          help={
            mode === "push"
              ? "Required: the Commit the Branch points at."
              : "Optional: defaults to the Branch head."
          }
        >
          <Input
            id="deploy-commit"
            value={commit}
            required={mode === "push"}
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
        {mode === "push" ? null : (
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
        )}
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
