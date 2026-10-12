import { redirect } from "next/navigation";
import { projectHref } from "@/lib/target";

/** A Project's Doctor checks are on its Monitor tab now, beside its Activity and what it uses. */
export default async function ProjectDoctorPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  redirect(`${projectHref((await params).name)}/monitor`);
}
