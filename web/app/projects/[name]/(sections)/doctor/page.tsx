import { attempt } from "@/lib/outcome";
import type { DoctorReport } from "@/lib/types";
import { read } from "@/server/daemon";
import { project } from "@/server/project";
import { Failure } from "@/components/bits";
import { DoctorTiles } from "@/components/doctor-report";

export default async function ProjectDoctorPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const found = await project(params);
  const report = await attempt(read({ action: "doctor", project: found.name }));
  return report.ok ? (
    <DoctorTiles report={report.value as DoctorReport} />
  ) : (
    <Failure failure={report.failure} />
  );
}
