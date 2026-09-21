import type { ListResult } from "../types";
import { href, useApi, useRead } from "../hooks";
import { Empty, Failure, Mono, Notice } from "../ui";
import { Targets } from "./Targets";
import { Deploy } from "./Deploy";
import { Logs } from "./Logs";
import { ActivityView } from "./Activity";
import { Config } from "./Config";
import { Recipes } from "./Recipes";
import { DoctorView } from "./Doctor";
import { Settings } from "./Settings";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TABS = [
  ["targets", "Targets"],
  ["deploy", "Deploy"],
  ["logs", "Logs"],
  ["activity", "Activity"],
  ["config", "Config"],
  ["recipes", "Recipes"],
  ["doctor", "Doctor"],
  ["settings", "Settings"],
] as const;
export function Project({
  name,
  tab,
  registration,
  reloadProjects,
}: {
  name: string;
  tab: string;
  registration: ListResult["projects"][number] | undefined;
  reloadProjects(): void;
}) {
  const api = useApi();
  const status = useRead(
    (signal) => api.command({ action: "status", project: name }, signal),
    `status:${name}`,
    3000,
  );
  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold [font-stretch:115%]">{name}</h1>
        {registration?.repoPath ? (
          <Mono className="text-muted-foreground">{registration.repoPath}</Mono>
        ) : null}
      </header>
      <Tabs
        value={tab}
        onValueChange={(next) => {
          window.location.hash = href("projects", name, next);
        }}
      >
        <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <TabsList variant="line" className="w-max border-b">
            {TABS.map(([value, label]) => (
              <TabsTrigger key={value} value={value} className="px-3">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>
      {status.data?.warnings?.map((warning) => (
        <Notice key={warning} tone="warn">
          {warning}
        </Notice>
      ))}
      {tab === "targets" ? (
        <>
          <Failure error={status.error} />
          <Targets project={name} status={status.data} reload={status.reload} />
        </>
      ) : tab === "deploy" ? (
        <Deploy
          project={name}
          repoPath={registration?.repoPath}
          reload={status.reload}
        />
      ) : tab === "logs" ? (
        <Logs project={name} targets={status.data?.targets ?? []} />
      ) : tab === "activity" ? (
        <ActivityView project={name} />
      ) : tab === "config" ? (
        <Config project={name} />
      ) : tab === "recipes" ? (
        <Recipes project={name} />
      ) : tab === "doctor" ? (
        <DoctorView project={name} />
      ) : tab === "settings" ? (
        <Settings
          project={name}
          repoPath={registration?.repoPath}
          reloadProjects={reloadProjects}
        />
      ) : (
        <Empty>Unknown tab.</Empty>
      )}
    </>
  );
}
