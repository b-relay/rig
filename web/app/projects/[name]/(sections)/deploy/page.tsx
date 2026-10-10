import { redirect } from "next/navigation";
import { projectHref } from "@/lib/target";

/** The Deploy tab became Deployments, which keeps the form beside the history; old links land there. */
export default async function DeployPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  redirect(`${projectHref((await params).name)}/deployments`);
}
