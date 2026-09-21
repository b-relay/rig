import { useState } from "react";
import type { OperationResult } from "../types";
import { href, useAct, useApi } from "../hooks";
import { Confirm, Failure, Field, Panel } from "../ui";
import { OperationNotice } from "./Targets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function Settings({
  project,
  repoPath,
  reloadProjects,
}: {
  project: string;
  repoPath: string | undefined;
  reloadProjects(): void;
}) {
  const api = useApi();
  const rename = useAct<OperationResult>();
  const repoint = useAct<OperationResult>();
  const forget = useAct<OperationResult>();
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  return (
    <>
      <Panel title="Rename" description="Every Target must be stopped first.">
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void rename
              .run(() => api.command({ action: "rename", project, newName }))
              .then((result) => {
                if (!result) return;
                reloadProjects();
                window.location.hash = href("projects", newName, "settings");
              });
          }}
        >
          <Field label="New name" htmlFor="rename" className="flex-1">
            <Input
              id="rename"
              value={newName}
              required
              onChange={(event) => setNewName(event.target.value)}
            />
          </Field>
          <Button type="submit" variant="outline" disabled={rename.busy}>
            Rename
          </Button>
        </form>
        <Failure error={rename.error} />
      </Panel>
      <Panel
        title="Repoint"
        description={
          <>
            Register the repository's new location after moving it. Currently{" "}
            <code>{repoPath ?? "unknown"}</code>.
          </>
        }
      >
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void repoint
              .run(() => api.command({ action: "repoint", project, newPath }))
              .then(reloadProjects);
          }}
        >
          <Field label="New absolute path" htmlFor="repoint" className="flex-1">
            <Input
              id="repoint"
              value={newPath}
              required
              pattern="/.*"
              className="font-mono text-xs"
              onChange={(event) => setNewPath(event.target.value)}
            />
          </Field>
          <Button type="submit" variant="outline" disabled={repoint.busy}>
            Repoint
          </Button>
        </form>
        <Failure error={repoint.error} />
        <OperationNotice result={repoint.result} />
      </Panel>
      <Panel
        title="Forget"
        description="Removes the registration from this Host. The repository and its rig.yaml are not touched."
      >
        <div>
          <Confirm
            title={`Forget Project ${project}?`}
            description="This Host stops managing it. Stopped Targets stay stopped; the repository is untouched."
            confirmLabel="Forget Project"
            destructive
            onConfirm={() =>
              void forget
                .run(() => api.command({ action: "forget", project }))
                .then((result) => {
                  if (!result) return;
                  reloadProjects();
                  window.location.hash = href();
                })
            }
          >
            <Button variant="destructive" disabled={forget.busy}>
              Forget Project
            </Button>
          </Confirm>
        </div>
        <Failure error={forget.error} />
      </Panel>
    </>
  );
}
