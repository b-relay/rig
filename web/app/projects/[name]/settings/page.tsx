import { project } from "@/server/project";
import { SettingsForms } from "@/components/settings-forms";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const found = await project(params);
  return <SettingsForms project={found.name} repoPath={found.repoPath} />;
}
