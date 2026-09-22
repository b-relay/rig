"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Failure, Field, OperationNotice, Section } from "./bits";
import { Confirm } from "./confirm";
import { useRun } from "./operations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SettingsForms({
  project,
  repoPath,
}: {
  project: string;
  repoPath: string;
}) {
  const router = useRouter();
  const rename = useRun({ refresh: false });
  const repoint = useRun();
  const forget = useRun({ refresh: false });
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  return (
    <>
      <Section title="Rename" description="Every Target must be stopped first.">
        <form
          className="flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void rename
              .run({ action: "rename", project, newName })
              .then((result) => {
                if (result)
                  router.push(
                    `/projects/${encodeURIComponent(newName)}/settings`,
                  );
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
        <Failure failure={rename.failure} />
      </Section>
      <Section
        title="Repoint"
        description={
          <>
            Register the repository's new location after moving it. Currently{" "}
            <code>{repoPath}</code>.
          </>
        }
      >
        <form
          className="flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void repoint.run({ action: "repoint", project, newPath });
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
        <Failure failure={repoint.failure} />
        <OperationNotice result={repoint.result} />
      </Section>
      <Section
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
              void forget.run({ action: "forget", project }).then((result) => {
                if (result) router.push("/");
              })
            }
          >
            <Button variant="destructive" disabled={forget.busy}>
              Forget Project
            </Button>
          </Confirm>
        </div>
        <Failure failure={forget.failure} />
      </Section>
    </>
  );
}
