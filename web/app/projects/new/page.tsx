import type { Metadata } from "next";
import { NewProjectForm } from "@/components/new-project-form";

export const metadata: Metadata = { title: "Add Project" };
export default function NewProjectPage() {
  return (
    <>
      <div>
        <h1 className="title text-2xl">Add Project</h1>
        <p className="text-sm text-muted-foreground">
          The same as rig init, from here.
        </p>
      </div>
      <NewProjectForm />
    </>
  );
}
