import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Mono } from "@/components/bits";
import { ProjectTabs } from "@/components/project-tabs";
import { project } from "@/server/project";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  return { title: (await params).name };
}
export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ name: string }>;
  children: ReactNode;
}) {
  const found = await project(params);
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="title text-2xl">{found.name}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Mono className="text-muted-foreground">{found.repoPath}</Mono>
          {found.missing ? (
            <span className="inline-flex items-center gap-1 text-xs text-bad">
              <AlertTriangle className="size-3.5" aria-hidden /> repository
              missing
            </span>
          ) : null}
        </div>
      </div>
      <ProjectTabs project={found.name} />
      {children}
    </>
  );
}
