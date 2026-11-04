"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { refusalText } from "@/lib/present";
import type { Failure as FailureShape } from "@/lib/outcome";
import type { ProjectStatusReport } from "@/lib/types";
import { Failure, Field, OperationNotice, Section, Warning } from "./bits";
import { Confirm } from "./confirm";
import { loadFresh, useRun } from "./operations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const onlyOnFailure = (_command: unknown, ok: boolean) => !ok;
/** Why rigd would refuse this change now, beneath its control; rigd decides again when it is asked. */
function Refused({
  refusal,
}: {
  refusal: NonNullable<ProjectStatusReport["refusals"]>["forget"];
}) {
  return refusal ? <Warning>{refusalText(refusal)}</Warning> : null;
}
export function SettingsForms({
  project,
  repoPath,
  refusals,
  statusFailure,
}: {
  project: string;
  repoPath: string;
  /** What rigd refuses of this Project's registration now; absent when none is. */
  refusals?: ProjectStatusReport["refusals"];
  /** Why its status could not be read, so what rigd would refuse is not known. Nothing is offered until a read succeeds. */
  statusFailure?: FailureShape;
}) {
  const router = useRouter();
  const rename = useRun({ refresh: onlyOnFailure });
  const repoint = useRun();
  const forget = useRun({ refresh: onlyOnFailure });
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const unknown = statusFailure !== undefined;
  return (
    <>
      <Failure failure={statusFailure} />
      <Section
        title="Rename"
        description="Every Target must be stopped first. The operator env files move to the new name."
      >
        <form
          className="flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void rename
              .run({ action: "rename", project, newName })
              .then((result) => {
                // A rename with warnings (env files copied, a save not confirmed on disk) stays here until they are read.
                if (result && !result.warnings?.length)
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
              maxLength={128}
              required
              onChange={(event) => setNewName(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="outline"
            disabled={unknown || rename.busy || refusals?.rename !== undefined}
          >
            Rename
          </Button>
        </form>
        <Refused refusal={refusals?.rename} />
        <Failure failure={rename.failure} />
        {rename.result?.warnings?.length ? (
          <>
            <OperationNotice result={rename.result} />
            <a
              href={`/projects/${encodeURIComponent(rename.result.project ?? newName)}/settings`}
              className="text-sm underline"
            >
              Go to {rename.result.project ?? newName}
            </a>
          </>
        ) : null}
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
          <Button
            type="submit"
            variant="outline"
            disabled={
              unknown || repoint.busy || refusals?.repoint !== undefined
            }
          >
            Repoint
          </Button>
        </form>
        <Refused refusal={refusals?.repoint} />
        <Failure failure={repoint.failure} />
        <OperationNotice result={repoint.result} />
      </Section>
      <Section
        title="Forget"
        tone="danger"
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
                if (result)
                  loadFresh(
                    `/?operation=${encodeURIComponent(result.operationId)}`,
                  );
              })
            }
          >
            <Button
              variant="destructive"
              disabled={
                unknown || forget.busy || refusals?.forget !== undefined
              }
            >
              Forget Project
            </Button>
          </Confirm>
        </div>
        <Refused refusal={refusals?.forget} />
        <Failure failure={forget.failure} />
      </Section>
    </>
  );
}
