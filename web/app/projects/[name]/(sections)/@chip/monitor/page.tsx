import { rangeOf } from "@/lib/usage";
import { projectMonitor } from "@/server/monitor";
import { project } from "@/server/project";
import { TargetChip } from "@/components/target-chip";

/** On the Monitor tab, the Project's name reads `name / target`: the Target chip that switches what the tab shows. */
export default async function MonitorChip({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ target?: string; range?: string }>;
}) {
  const found = await project(params);
  const query = await searchParams;
  const view = await projectMonitor(
    found.name,
    rangeOf(query.range),
    query.target,
  );
  return (
    <>
      <span aria-hidden className="font-normal text-muted-foreground">
        /
      </span>
      <TargetChip
        current={view.target}
        targets={view.targets}
        allHref={view.hrefOf("all")}
        {...(view.allDetail && { allDetail: view.allDetail })}
      />
    </>
  );
}
