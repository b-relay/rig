import { attempt } from "@/lib/outcome";
import type { DeploymentContext } from "@/lib/types";
import { read } from "@/server/daemon";
import { project } from "@/server/project";
import { Failure, Section } from "@/components/bits";
import { DeployForm } from "@/components/deploy-form";

export default async function DeployPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const found = await project(params);
  const context = await attempt(
    read({ action: "deployment-context", project: found.name }),
  );
  return (
    <Section
      title="Deploy"
      description="A deploy reads the committed rig.yaml of the Commit it deploys."
    >
      {context.ok ? (
        <DeployForm
          project={found.name}
          repoPath={found.repoPath}
          context={context.value as DeploymentContext}
        />
      ) : (
        <Failure failure={context.failure} />
      )}
    </Section>
  );
}
