import { attempt } from "@/lib/outcome";
import type { RecipeReport } from "@/lib/types";
import { read } from "@/server/daemon";
import { project } from "@/server/project";
import { Failure, Field, Section } from "@/components/bits";
import { RecipeFindings } from "@/components/recipe-report";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** A plain GET form: the Service to compare lives in the URL, so the page needs no script for it. */
export default async function RecipesPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ service?: string }>;
}) {
  const [found, { service }] = await Promise.all([
    project(params),
    searchParams,
  ]);
  const serviceName = service?.trim() ?? "";
  const report = await attempt(
    read({
      action: "recipe-diff",
      project: found.name,
      ...(serviceName ? { serviceName } : {}),
    }),
  );
  return (
    <Section
      title="Recipes"
      description="Compares Services generated from a bundled recipe with the recipe's current version."
    >
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        method="get"
      >
        <Field
          label="Service"
          htmlFor="recipe-service"
          help="Leave empty to compare every marked Service."
          className="flex-1"
        >
          <Input
            id="recipe-service"
            name="service"
            defaultValue={serviceName}
            pattern="[a-z0-9][a-z0-9-]*"
          />
        </Field>
        <Button type="submit" variant="outline">
          Compare
        </Button>
      </form>
      {report.ok ? (
        <RecipeFindings report={report.value as RecipeReport} />
      ) : (
        <Failure failure={report.failure} />
      )}
    </Section>
  );
}
