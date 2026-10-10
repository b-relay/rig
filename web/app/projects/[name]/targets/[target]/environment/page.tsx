import Link from "next/link";
import { layeredKeys } from "@/lib/env";
import { projectHref } from "@/lib/target";
import { envFiles } from "@/server/env";
import { target } from "@/server/target";
import { Failure } from "@/components/bits";
import { EnvLayers } from "@/components/env-layers";

/** What this Target's processes get from the operator env files: for each Service, every name with
 * the file that wins, in the order rigd layers them. Editing happens on the Project's Environment page. */
export default async function TargetEnvironmentPage({
  params,
}: {
  params: Promise<{ name: string; target: string }>;
}) {
  const { project, target: report } = await target(params);
  const files = await envFiles(project.name);
  if (!files.ok) return <Failure failure={files.failure} />;
  const editBase = `${projectHref(project.name)}/environment`;
  const services = report.components
    .filter((component) => component.kind === "managed")
    .map((component) => component.name);
  const tools = report.components.some(
    (component) => component.kind === "installed",
  );
  return (
    <>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Each Service of {report.name} gets the Project&apos;s{" "}
        <code>all.env</code> and <code>{report.kind}.env</code>, then its own,
        later files winning; a Tool gets the Project&apos;s alone. Processes
        read them when they start, so restart {report.name} after a change.{" "}
        <Link href={editBase}>Edit the files</Link>.
      </p>
      <div className="grid gap-4">
        {services.map((service) => (
          <EnvLayers
            key={service}
            project={project.name}
            title={`Service ${service}`}
            keys={layeredKeys(files.value.files, report.kind, service)}
            editBase={editBase}
          />
        ))}
        {tools || services.length === 0 ? (
          <EnvLayers
            project={project.name}
            title="Tools and builds"
            keys={layeredKeys(files.value.files, report.kind)}
            editBase={editBase}
          />
        ) : null}
      </div>
    </>
  );
}
