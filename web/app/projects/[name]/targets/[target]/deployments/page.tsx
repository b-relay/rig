import Link from "next/link";
import { deploymentRows } from "@/lib/deployments";
import { projectHref } from "@/lib/target";
import { deploymentHistory } from "@/server/deployments";
import { target } from "@/server/target";
import { Failure, Mono, Panel } from "@/components/bits";
import { DeploymentsTable } from "@/components/deployments-table";

/** This Target's deploys, newest first, each one a Commit it can be rolled back to. */
export default async function TargetDeploymentsPage({
  params,
}: {
  params: Promise<{ name: string; target: string }>;
}) {
  const { project, target: report } = await target(params);
  if (report.kind === "working")
    return (
      <Panel title="Deployments">
        <p className="text-sm text-muted-foreground">
          The working Target is never deployed: it runs the checkout at{" "}
          <Mono>{project.repoPath}</Mono> as it is on disk. Restart it to apply
          changes.
        </p>
      </Panel>
    );
  const history = await deploymentHistory(project.name);
  return (
    <Panel
      title="History"
      description={
        <>
          Deploys of {report.name}, newest first.{" "}
          <Link href={`${projectHref(project.name)}/deployments`}>
            Deploy a Branch or Commit
          </Link>
          .
        </>
      }
      flush
    >
      {history.ok ? (
        <DeploymentsTable
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
        <div className="p-4">
          <Failure failure={history.failure} />
        </div>
      )}
    </Panel>
  );
}
