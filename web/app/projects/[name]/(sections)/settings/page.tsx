import { project } from "@/server/project";
import { SettingsForms } from "@/components/settings-forms";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const found = await project(params);
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <SettingsForms project={found.name} repoPath={found.repoPath} />
    </div>
  );
}
