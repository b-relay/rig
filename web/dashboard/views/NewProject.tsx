import { useState } from "react";
import { Search } from "lucide-react";
import type {
  InitializationInfo,
  OperationResult,
  RuntimeCommand,
} from "../types";
import { href, useAct, useApi } from "../hooks";
import { Failure, Field, Notice, Panel } from "../ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Kind = "existing" | "service" | "tool";
export function NewProject({ reloadProjects }: { reloadProjects(): void }) {
  const api = useApi();
  const inspect = useAct<InitializationInfo>();
  const init = useAct<OperationResult>();
  const [repoPath, setRepoPath] = useState("");
  const [project, setProject] = useState("");
  const [productionBranch, setProductionBranch] = useState("");
  const [domain, setDomain] = useState("");
  const [createGit, setCreateGit] = useState(false);
  const [kind, setKind] = useState<Kind>("service");
  const [name, setName] = useState("");
  const [run, setRun] = useState("");
  const [port, setPort] = useState("");
  const [ready, setReady] = useState("");
  const [bin, setBin] = useState("");
  const [build, setBuild] = useState("");
  const info = inspect.result;
  const look = () =>
    void inspect
      .run(() => api.command({ action: "initialization-info", repoPath }))
      .then((found) => {
        if (!found) return;
        setProject(found.name);
        setProductionBranch(found.productionBranch);
        setKind(found.existing ? "existing" : "service");
      });
  const register = () => {
    const command: RuntimeCommand & { action: "init" } = {
      action: "init",
      repoPath,
      ...(project ? { project } : {}),
      // An existing rig.yaml already decides these; sending them only earns a "not applied" warning.
      ...(productionBranch && kind !== "existing" ? { productionBranch } : {}),
      ...(domain && kind !== "existing" ? { domain } : {}),
      ...(createGit ? { createGit } : {}),
      ...(kind === "service"
        ? {
            service: {
              name,
              run,
              ...(port ? { port: Number(port) } : {}),
              ...(ready ? { ready } : {}),
            },
          }
        : kind === "tool"
          ? { tool: { name, bin, ...(build ? { build } : {}) } }
          : {}),
    };
    void init
      .run(() => api.command(command))
      .then((result) => {
        if (!result) return;
        reloadProjects();
        if (result.project)
          window.location.hash = href("projects", result.project);
      });
  };
  return (
    <>
      <h1 className="text-3xl font-bold [font-stretch:115%]">Add Project</h1>
      <Panel
        title="Repository"
        description="Rig registers a Git repository on this Mac and writes its rig.yaml when there is none."
      >
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            look();
          }}
        >
          <Field
            label="Repository path"
            htmlFor="repo-path"
            help="Absolute path on this Mac."
            className="flex-1"
          >
            <Input
              id="repo-path"
              value={repoPath}
              required
              pattern="/.*"
              className="font-mono text-xs"
              placeholder="/Users/you/code/app"
              onChange={(event) => setRepoPath(event.target.value)}
            />
          </Field>
          <Button type="submit" variant="outline" disabled={inspect.busy}>
            <Search />
            Inspect
          </Button>
        </form>
        <Failure error={inspect.error} />
      </Panel>
      {info ? (
        <Panel title="Register">
          <form
            className="flex max-w-lg flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              register();
            }}
          >
            {info.existing ? (
              <Notice>
                This directory already has a rig.yaml; it is kept as written.
              </Notice>
            ) : null}
            <Field label="Project name" htmlFor="project-name">
              <Input
                id="project-name"
                value={project}
                required
                disabled={info.existing}
                onChange={(event) => setProject(event.target.value)}
              />
            </Field>
            {info.existing ? null : (
              <>
                <Field
                  label="Production Branch"
                  htmlFor="production-branch"
                  help={
                    info.currentBranch
                      ? `Checked out: ${info.currentBranch}`
                      : undefined
                  }
                >
                  <Input
                    id="production-branch"
                    value={productionBranch}
                    onChange={(event) =>
                      setProductionBranch(event.target.value)
                    }
                  />
                </Field>
                <Field
                  label="Domain"
                  htmlFor="domain"
                  help="Optional. The Stable Target serves it; Previews get subdomains."
                >
                  <Input
                    id="domain"
                    value={domain}
                    placeholder="app.example.com"
                    onChange={(event) => setDomain(event.target.value)}
                  />
                </Field>
                <Tabs
                  value={kind}
                  onValueChange={(next) => setKind(next as Kind)}
                >
                  <TabsList>
                    <TabsTrigger value="service">Service</TabsTrigger>
                    <TabsTrigger value="tool">Tool</TabsTrigger>
                  </TabsList>
                </Tabs>
                <Field
                  label={kind === "service" ? "Service name" : "Tool name"}
                  htmlFor="entry-name"
                >
                  <Input
                    id="entry-name"
                    value={name}
                    required
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
                {kind === "service" ? (
                  <>
                    <Field label="Run command" htmlFor="run">
                      <Input
                        id="run"
                        value={run}
                        required
                        className="font-mono text-xs"
                        onChange={(event) => setRun(event.target.value)}
                      />
                    </Field>
                    <Field
                      label="Port"
                      htmlFor="port"
                      help="Assigned automatically when empty."
                    >
                      <Input
                        id="port"
                        value={port}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        onChange={(event) => setPort(event.target.value)}
                      />
                    </Field>
                    <Field
                      label="Readiness check"
                      htmlFor="ready"
                      help="Optional: a localhost URL or a shell command."
                    >
                      <Input
                        id="ready"
                        value={ready}
                        className="font-mono text-xs"
                        onChange={(event) => setReady(event.target.value)}
                      />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field
                      label="Executable"
                      htmlFor="bin"
                      help="The file the Tool installs."
                    >
                      <Input
                        id="bin"
                        value={bin}
                        required
                        className="font-mono text-xs"
                        onChange={(event) => setBin(event.target.value)}
                      />
                    </Field>
                    <Field
                      label="Build command"
                      htmlFor="build"
                      help="Optional."
                    >
                      <Input
                        id="build"
                        value={build}
                        className="font-mono text-xs"
                        onChange={(event) => setBuild(event.target.value)}
                      />
                    </Field>
                  </>
                )}
              </>
            )}
            {info.gitRequired ? (
              <Label className="gap-2 font-normal">
                <Checkbox
                  checked={createGit}
                  onCheckedChange={(next) => setCreateGit(next === true)}
                />
                This directory is not a Git repository; initialize one
              </Label>
            ) : null}
            <div>
              <Button type="submit" disabled={init.busy}>
                Register Project
              </Button>
            </div>
          </form>
          <Failure error={init.error} />
        </Panel>
      ) : null}
    </>
  );
}
