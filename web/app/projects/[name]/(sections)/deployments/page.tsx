import { attempt } from "@/lib/outcome";
import { deploymentRows } from "@/lib/deployments";
import type { DeploymentContext } from "@/lib/types";
import { read } from "@/server/daemon";
import { deploymentHistory } from "@/server/deployments";
import { project } from "@/server/project";
import { projectStatus } from "@/server/status";
import { Failure, Panel } from "@/components/bits";
import { DeployForm } from "@/components/deploy-form";
import { DeploymentsTable } from "@/components/deployments-table";

/** Every deploy of the Project's stable Target and Previews, with rollback, beside the form that
 * deploys a Branch or a Commit. */
export default async function DeploymentsPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const found = await project(params);
  const [context, history, status] = await Promise.all([
    attempt(read({ action: "deployment-context", project: found.name })),
    deploymentHistory(found.name),
    projectStatus(found.name),
  ]);
  return (
    <div className="grid items-start gap-4 2xl:grid-cols-[minmax(0,2fr)_minmax(22rem,1fr)]">
      <Panel
        title="History"
        description="Each deploy's revision, when it ran, how it ended and how long it took."
        flush
      >
        {history.ok ? (
          <DeploymentsTable
            project={found.name}
            rows={deploymentRows(
              history.value.deployments,
              status.ok ? status.value.targets : [],
            )}
            now={Date.now()}
          />
        ) : (
          <div className="p-4">
            <Failure failure={history.failure} />
          </div>
        )}
      </Panel>
      <Panel
        title="New deployment"
        description="A deploy reads the committed rig.yaml of the Commit it deploys."
      >
        {context.ok ? (
          <DeployForm
            project={found.name}
            context={context.value as DeploymentContext}
          />
        ) : (
          <Failure failure={context.failure} />
        )}
      </Panel>
    </div>
  );
}
