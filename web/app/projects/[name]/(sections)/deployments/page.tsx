import { attempt } from "@/lib/outcome";
import { deploymentRows } from "@/lib/deployments";
import type { DeploymentContext } from "@/lib/types";
import { read } from "@/server/daemon";
import { deploymentHistory } from "@/server/deployments";
import { project } from "@/server/project";
import { projectStatus } from "@/server/status";
import { Failure, Panel } from "@/components/bits";
import { DeployForm } from "@/components/deploy-form";
import { DeploymentList } from "@/components/deployment-list";

/** Every deploy of the Project's stable Target and Previews as a stack of cards, with rollback,
 * beside the form that deploys a Branch or a Commit. */
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
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <section className="flex min-w-0 flex-col gap-3">
        <h2 className="text-sm font-semibold">
          History{" "}
          <span className="font-normal text-muted-foreground">
            newest first
          </span>
        </h2>
        {history.ok ? (
          <DeploymentList
            project={found.name}
            rows={deploymentRows(
              history.value.deployments,
              status.ok ? status.value.targets : [],
            )}
            now={Date.now()}
          />
        ) : (
          <Failure failure={history.failure} />
        )}
      </section>
      <Panel
        title="New deployment"
        description="A deploy reads the committed rig.yaml of the Commit it deploys."
        className="xl:sticky xl:top-16"
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
