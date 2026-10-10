import { attempt } from "@/lib/outcome";
import type { ConfigRead, ConfigReport } from "@/lib/types";
import { editConfig, read } from "@/server/daemon";
import { project } from "@/server/project";
import { Failure } from "@/components/bits";
import { ConfigEditor } from "@/components/config-editor";

export default async function ConfigPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const found = await project(params);
  const [source, validated] = await Promise.all([
    attempt(
      editConfig({
        action: "read",
        project: found.name,
      }) as Promise<ConfigRead>,
    ),
    attempt(
      read({ action: "config", project: found.name }) as Promise<ConfigReport>,
    ),
  ]);
  if (!source.ok) return <Failure failure={source.failure} />;
  return (
    <ConfigEditor
      project={found.name}
      source={source.value}
      validated={validated}
    />
  );
}
