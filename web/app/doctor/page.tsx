import type { Metadata } from "next";
import { attempt } from "@/lib/outcome";
import type { DoctorReport } from "@/lib/types";
import { read } from "@/server/daemon";
import { Failure, PageHeader } from "@/components/bits";
import { DoctorTable } from "@/components/doctor-report";

export const metadata: Metadata = { title: "Doctor" };
export default async function DoctorPage() {
  const report = await attempt(read({ action: "doctor" }));
  return (
    <>
      <PageHeader
        title="Doctor"
        description="The Host checks rig doctor runs; each Project's own checks are on its Doctor tab."
      />
      {report.ok ? (
        <DoctorTable report={report.value as DoctorReport} />
      ) : (
        <Failure failure={report.failure} />
      )}
    </>
  );
}
