import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, Rocket } from "lucide-react";
import { Failure, HealthDot, Mono, PageHeader } from "@/components/bits";
import { ProjectIcon } from "@/components/project-icon";
import { ProjectTabs } from "@/components/project-tabs";
import { Button } from "@/components/ui/button";
import { projectHealth } from "@/lib/health";
import { projectHref } from "@/lib/target";
import { project } from "@/server/project";
import { settled } from "@/server/settled";
import { projectStatus } from "@/server/status";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  return { title: (await params).name };
}
/** A Project's own sections, under its icon, name and repository, with the tabs that move between them. */
export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ name: string }>;
  children: ReactNode;
}) {
  const read = await settled(project(params));
  if (!read.ok)
    return (
      <>
        <PageHeader title={(await params).name} />
        <Failure failure={read.failure} />
      </>
    );
  const found = read.value;
  return (
    <>
      <PageHeader
        icon={
          // The icon waits for status (favicon and health); the sections that do not need it render meanwhile.
          <Suspense fallback={<ProjectIcon project={found.name} />}>
            <HeaderIcon project={found.name} missing={found.missing === true} />
          </Suspense>
        }
        eyebrow={
          <Link href="/" className="text-muted-foreground">
            Projects
          </Link>
        }
        title={found.name}
        description={
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <Mono className="truncate break-normal text-muted-foreground">
              {found.repoPath}
            </Mono>
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
/** The Project's icon with its health dot, once its status has answered. */
async function HeaderIcon({
  project,
  missing,
}: {
  project: string;
  missing: boolean;
}) {
  const status = missing ? undefined : await projectStatus(project);
  const targets = status?.ok ? status.value.targets : [];
  const stable = targets.find((target) => target.kind === "stable");
  return (
    <span className="relative">
      <ProjectIcon project={project} favicon={stable?.route !== undefined} />
      <HealthDot
        health={
          missing || (status && !status.ok)
            ? "red"
            : projectHealth(targets.map((target) => target.state))
        }
        className="absolute -right-1 -bottom-1 size-3.5 ring-[3px] ring-background"
      />
    </span>
  );
}
