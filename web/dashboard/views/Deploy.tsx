import { useState } from "react";
import { Rocket } from "lucide-react";
import type { OperationResult } from "../types";
import { useAct, useApi, useRead } from "../hooks";
import { Facts, Failure, Field, Panel } from "../ui";
import { OperationNotice } from "./Targets";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Mode = "stable" | "preview" | "push";
export function Deploy({
  project,
  repoPath,
  reload,
}: {
  project: string;
  repoPath: string | undefined;
  reload(): void;
}) {
  const api = useApi();
  const context = useRead(
    (signal) => api.command({ action: "deployment-context", project }, signal),
    `context:${project}`,
  );
  const act = useAct<OperationResult>();
  const [mode, setMode] = useState<Mode>("stable");
  const [branch, setBranch] = useState("");
  const [commit, setCommit] = useState("");
  const [deployment, setDeployment] = useState("");
  const [force, setForce] = useState(false);
  const [noUp, setNoUp] = useState(false);
  const stable = context.data?.targets.stable;
  // Without its name a Stable deploy would be read as the Working copy; without the path a push is refused.
  const ready =
    mode === "stable"
      ? Boolean(stable)
      : mode === "push"
        ? Boolean(repoPath)
        : true;
  const submit = () => {
    if (!ready) return;
    const source = {
      ...(branch ? { branch } : {}),
      ...(commit ? { commit } : {}),
    };
    const options = { ...(force ? { force } : {}), ...(noUp ? { noUp } : {}) };
    void act
      .run(() =>
        mode === "push"
          ? api.command({ action: "git-push", project, repoPath, ...source })
          : api.command({
              action: "deploy",
              project,
              target: mode === "stable" ? stable : "preview",
              ...(mode === "preview" && deployment ? { deployment } : {}),
              ...source,
              ...options,
            }),
      )
      .then(reload);
  };
  return (
    <Panel title="Deploy">
      <Failure error={context.error} />
      {context.data ? (
        <Facts
          items={[
            ["Production Branch", context.data.productionBranch],
            ["Checked-out Branch", context.data.currentBranch ?? "detached"],
          ]}
        />
      ) : null}
      <Tabs value={mode} onValueChange={(next) => setMode(next as Mode)}>
        <div className="-mx-5 overflow-x-auto px-5">
          <TabsList className="w-max">
            <TabsTrigger value="stable">
              Stable{stable ? ` (${stable})` : ""}
            </TabsTrigger>
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
                ? context.data?.productionBranch
                : (context.data?.currentBranch ?? "")
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
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button type="submit" disabled={act.busy || !ready}>
            <Rocket />
            {act.busy ? "Deploying…" : "Deploy"}
          </Button>
          {ready ? null : (
            <p className="text-xs text-muted-foreground">
              {mode === "stable"
                ? "Deploying to the Stable Target needs this Project's config to load first."
                : "This Project's repository path is not known yet."}
            </p>
          )}
        </div>
      </form>
      <Failure error={act.error} />
      <OperationNotice result={act.result} />
    </Panel>
  );
}
