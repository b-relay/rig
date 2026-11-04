import { project } from "@/server/project";
import { projectStatus } from "@/server/status";
import { SettingsForms } from "@/components/settings-forms";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const found = await project(params);
  const status = await projectStatus(found.name);
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <SettingsForms
        project={found.name}
        repoPath={found.repoPath}
        {...(status.ok && status.value.refusals
          ? { refusals: status.value.refusals }
          : {})}
      />
    </div>
  );
}
