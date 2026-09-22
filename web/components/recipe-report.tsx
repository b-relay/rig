import type { RecipeChange, RecipeReport } from "@/lib/types";
import { Empty, Mono, Notice } from "./bits";

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
      <table className="w-full text-sm">
        <tbody className="ruled">
          {changes.map((change) => (
            <tr key={change.path}>
              <td className="py-1 pr-3 font-mono text-xs">{change.path}</td>
              <td className="py-1 pr-3 font-mono text-xs text-bad line-through">
                {change.from ?? "—"}
              </td>
              <td className="py-1 font-mono text-xs text-good">
                {change.to ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
/** Each marked Service against the recipe it was generated from and the bundled version. */
export function RecipeFindings({ report }: { report: RecipeReport }) {
  return (
    <div className="flex flex-col gap-4">
      <Mono className="text-muted-foreground">{report.path}</Mono>
      {report.findings.length === 0 ? (
        <Empty>No Service in this config was generated from a recipe.</Empty>
      ) : null}
      <div className="ruled flex flex-col">
        {report.findings.map((finding) => (
          <div key={finding.service} className="flex flex-col gap-2 py-4">
            <h3 className="font-mono text-sm font-semibold">
              {finding.service}
            </h3>
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
      </div>
    </div>
  );
}
