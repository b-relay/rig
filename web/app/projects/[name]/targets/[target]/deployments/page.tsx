import Link from "next/link";
import { FolderGit2 } from "lucide-react";
import { deploymentRows } from "@/lib/deployments";
import { projectHref } from "@/lib/target";
import { deploymentHistory } from "@/server/deployments";
import { target } from "@/server/target";
import { Empty, Failure, Mono } from "@/components/bits";
import { DeploymentList } from "@/components/deployment-list";

/** This Target's deploys, newest first, each one a Commit it can be rolled back to. */
export default async function TargetDeploymentsPage({
  params,
}: {
  params: Promise<{ name: string; target: string }>;
}) {
  const { project, target: report } = await target(params);
  if (report.kind === "working")
    return (
      <Empty icon={FolderGit2} title="The working Target is never deployed">
        It runs the checkout at <Mono>{project.repoPath}</Mono> as it is on
        disk. Restart it to apply changes.
      </Empty>
    );
  const history = await deploymentHistory(project.name);
  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Deploys of {report.name}, newest first.{" "}
        <Link href={`${projectHref(project.name)}/deployments`}>
          Deploy a Branch or Commit
        </Link>
        .
      </p>
      {history.ok ? (
        <DeploymentList
          project={project.name}
          rows={deploymentRows(
            history.value.deployments.filter(
              (deploy) => deploy.target === report.name,
            ),
            [report],
          )}
          showTarget={false}
          now={Date.now()}
        />
      ) : (
        <Failure failure={history.failure} />
      )}
    </section>
  );
}
