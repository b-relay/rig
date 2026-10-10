import { attempt } from "@/lib/outcome";
import type { DeploymentContext } from "@/lib/types";
import { read } from "@/server/daemon";
import { project } from "@/server/project";
import { Failure, Panel } from "@/components/bits";
import { DeployForm } from "@/components/deploy-form";

/** Deploy a Branch or Commit to the stable Target or a Preview. */
export default async function DeploymentsPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const found = await project(params);
  const context = await attempt(
    read({ action: "deployment-context", project: found.name }),
  );
  return (
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
  );
}
