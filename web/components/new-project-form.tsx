"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import type { InitializationInfo } from "@/lib/types";
import { initCommand } from "@/lib/init-command";
import { Failure, Field, Notice, Section } from "./bits";
import { useRun } from "./operations";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Kind = "existing" | "service" | "tool";
export function NewProjectForm() {
  const router = useRouter();
  const inspect = useRun<InitializationInfo>({ refresh: false });
  const init = useRun({ refresh: false });
  const [repoPath, setRepoPath] = useState("");
  const [project, setProject] = useState("");
  const [productionBranch, setProductionBranch] = useState("");
  const [domain, setDomain] = useState("");
  const [createGit, setCreateGit] = useState(false);
  const [kind, setKind] = useState<Kind>("service");
  const [name, setName] = useState("");
  const [serviceCommand, setServiceCommand] = useState("");
  const [port, setPort] = useState("");
  const [healthcheck, setHealthcheck] = useState("");
  const [bin, setBin] = useState("");
  const [build, setBuild] = useState("");
  const info = inspect.result;
  const look = () =>
    void inspect
      .run({ action: "initialization-info", repoPath })
      .then((found) => {
        if (!found) return;
        setProject(found.name);
        setProductionBranch(found.productionBranch);
        setKind(found.existing ? "existing" : "service");
      });
  const register = () => {
    const command = initCommand({
      repoPath,
      project,
      productionBranch,
      domain,
      createGit,
      kind,
      name,
      serviceCommand,
      port,
      healthcheck,
      bin,
      build,
    });
    void init.run(command).then((result) => {
      if (result?.project)
        router.push(`/projects/${encodeURIComponent(result.project)}`);
    });
  };
  return (
    <>
      <Section
        title="Repository"
        description="Rig registers a Git repository on this Mac and writes its rig.yaml when there is none."
      >
        <form
          className="flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end"
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
        <Failure failure={inspect.failure} />
      </Section>
      {info ? (
        <Section title="Register">
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
                  help="Optional. The stable Target serves it; a Preview gets the first label, a dash and its name, as in app-feature-1a2b3c4d.example.com."
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
                    <Field label="Command" htmlFor="service-command">
                      <Input
                        id="service-command"
                        value={serviceCommand}
                        required
                        className="font-mono text-xs"
                        onChange={(event) =>
                          setServiceCommand(event.target.value)
                        }
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
                      label="Health check"
                      htmlFor="healthcheck"
                      help="Optional: a localhost URL or a shell command, written as healthcheck.test."
                    >
                      <Input
                        id="healthcheck"
                        value={healthcheck}
                        className="font-mono text-xs"
                        onChange={(event) => setHealthcheck(event.target.value)}
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
          <Failure failure={init.failure} />
        </Section>
      ) : null}
    </>
  );
}
