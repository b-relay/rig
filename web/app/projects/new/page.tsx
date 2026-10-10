import type { Metadata } from "next";
import { PageHeader } from "@/components/bits";
import { NewProjectForm } from "@/components/new-project-form";

export const metadata: Metadata = { title: "Add Project" };
export default function NewProjectPage() {
  return (
    <>
      <PageHeader
        title="Add Project"
        description="The same as rig init, from here."
      />
      <NewProjectForm />
    </>
  );
}
