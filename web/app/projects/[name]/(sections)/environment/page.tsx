import { parseScopeKey, readersOf, scopeKey } from "@/lib/env";
import { projectHref } from "@/lib/target";
import { envFiles } from "@/server/env";
import { project } from "@/server/project";
import { projectStatus } from "@/server/status";
import { Failure, Mono } from "@/components/bits";
import { EnvScopes } from "@/components/env-scopes";
import { SecretsEditor } from "@/components/secrets-editor";

/** The Project's secrets: the operator env files under the Rig root that rigd layers into each
 * process's environment, chosen on the left and edited on the right. */
export default async function EnvironmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const [found, { scope }] = await Promise.all([project(params), searchParams]);
  const [files, status] = await Promise.all([
    envFiles(found.name),
    projectStatus(found.name),
  ]);
  if (!files.ok) return <Failure failure={files.failure} />;
  const wanted = scopeKey(parseScopeKey(scope));
  const file =
    files.value.files.find((each) => scopeKey(each.scope) === wanted) ??
    files.value.files[0]!;
  return (
    <>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Secrets live in env files outside every checkout, under{" "}
        <Mono>{files.value.directory}</Mono>. Each process gets the
        Project&apos;s files, then its Service&apos;s, each for every Target and
        then for its own role, later files winning. rig.yaml&apos;s own{" "}
        <code>env_file</code> entries are listed in the{" "}
        <a href={`${projectHref(found.name)}/config`}>config</a>.
      </p>
      <div className="grid items-start gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <EnvScopes
          base={`${projectHref(found.name)}/environment`}
          services={files.value.services}
          files={files.value.files}
          selected={scopeKey(file.scope)}
        />
        <SecretsEditor
          key={scopeKey(file.scope)}
          project={found.name}
          file={file}
          readers={readersOf(file.scope, status.ok ? status.value.targets : [])}
        />
      </div>
    </>
  );
}
