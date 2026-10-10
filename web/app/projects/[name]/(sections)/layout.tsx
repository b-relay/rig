import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, Rocket } from "lucide-react";
import { Mono, PageHeader } from "@/components/bits";
import { ProjectTabs } from "@/components/project-tabs";
import { Button } from "@/components/ui/button";
import { projectHref } from "@/lib/target";
import { project } from "@/server/project";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  return { title: (await params).name };
}
/** A Project's own sections, under its name and repository, with the tabs that move between them. */
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
      <PageHeader
        eyebrow={
          <>
            <Link href="/" className="text-muted-foreground">
              Projects
            </Link>{" "}
            /
          </>
        }
        title={found.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Mono className="text-muted-foreground">{found.repoPath}</Mono>
            {found.missing ? (
              <span className="inline-flex items-center gap-1 text-xs text-bad">
                <AlertTriangle className="size-3.5" aria-hidden /> repository
                missing
              </span>
            ) : null}
          </span>
        }
        actions={
          <Button asChild size="sm" variant="outline">
            <Link
              href={`${projectHref(found.name)}/deployments`}
              className="text-foreground no-underline"
            >
              <Rocket /> Deploy
            </Link>
          </Button>
        }
      />
      <ProjectTabs project={found.name} />
      {children}
    </>
  );
}
