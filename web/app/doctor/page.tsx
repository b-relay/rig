import type { Metadata } from "next";
import { attempt } from "@/lib/outcome";
import type { DoctorReport } from "@/lib/types";
import { read } from "@/server/daemon";
import { Failure } from "@/components/bits";
import { DoctorTable } from "@/components/doctor-report";

export const metadata: Metadata = { title: "Doctor" };
export default async function DoctorPage() {
  const report = await attempt(read({ action: "doctor" }));
  return (
    <>
      <div>
        <h1 className="title text-2xl">Doctor</h1>
        <p className="text-sm text-muted-foreground">
          The Host checks rig doctor runs.
        </p>
      </div>
      {report.ok ? (
        <DoctorTable report={report.value as DoctorReport} />
      ) : (
        <Failure failure={report.failure} />
      )}
    </>
  );
}
