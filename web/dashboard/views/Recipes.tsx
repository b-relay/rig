import { useState } from "react";
import type { RecipeChange } from "../types";
import { useApi, useRead } from "../hooks";
import { Empty, Failure, Field, Mono, Notice, Panel } from "../ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

function Changes({
  title,
  changes,
}: {
  title: string;
  changes: readonly RecipeChange[];
}) {
  if (changes.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-medium">{title}</h4>
      <Table>
        <TableBody>
          {changes.map((change) => (
            <TableRow key={change.path}>
              <TableCell className="font-mono text-xs">{change.path}</TableCell>
              <TableCell className="font-mono text-xs text-bad line-through">
                {change.from ?? "—"}
              </TableCell>
              <TableCell className="font-mono text-xs text-good">
                {change.to ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
export function Recipes({ project }: { project: string }) {
  const api = useApi();
  const [serviceName, setServiceName] = useState("");
  const [asked, setAsked] = useState("");
  const report = useRead(
    (signal) =>
      api.command(
        {
          action: "recipe-diff",
          project,
          ...(asked ? { serviceName: asked } : {}),
        },
        signal,
      ),
    `recipes:${project}:${asked}`,
  );
  return (
    <Panel
      title="Recipes"
      description="Compares Services generated from a bundled recipe with the recipe's current version."
    >
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          setAsked(serviceName.trim());
        }}
      >
        <Field
          label="Service"
          htmlFor="recipe-service"
          help="Leave empty to compare every marked Service."
          className="flex-1"
        >
          <Input
            id="recipe-service"
            value={serviceName}
            pattern="[a-z0-9][a-z0-9-]*"
            onChange={(event) => setServiceName(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="outline">
          Compare
        </Button>
      </form>
      <Failure error={report.error} />
      {report.data ? (
        <Mono className="text-muted-foreground">{report.data.path}</Mono>
      ) : null}
      {report.data?.findings.length === 0 ? (
        <Empty>No Service in this config was generated from a recipe.</Empty>
      ) : null}
      {report.data?.findings.map((finding) => (
        <div
          key={finding.service}
          className="flex flex-col gap-2 rounded-md border p-4"
        >
          <h3 className="font-semibold">{finding.service}</h3>
          {finding.status === "malformed" ? (
            <Notice tone="warn">
              Unreadable recipe marker: {finding.marker}
            </Notice>
          ) : finding.status === "compared" ? (
            <>
              <p className="text-sm">
                {finding.recipe} v{finding.version}
                {finding.bundled === finding.version
                  ? " (current)"
                  : `, bundled is v${finding.bundled}`}
                {finding.generatedAs
                  ? `, generated as ${finding.generatedAs}`
                  : ""}
              </p>
              <Changes title="Your changes" changes={finding.customized} />
              <Changes title="Available update" changes={finding.update} />
              {finding.customized.length + finding.update.length === 0 ? (
                <Empty>Identical to the recipe.</Empty>
              ) : null}
            </>
          ) : (
            <Notice tone="warn">
              {finding.status === "unknown-recipe"
                ? `This rigd bundles no recipe named ${finding.recipe}.`
                : `This rigd does not bundle ${finding.recipe} v${finding.version}.`}
            </Notice>
          )}
        </div>
      ))}
    </Panel>
  );
}
