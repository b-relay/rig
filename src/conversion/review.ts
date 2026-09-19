import { z } from "zod";

const text = z.string().min(1);
/** What the operator decided about one retired hook. Rig never decides this: a hook has no equivalent by default. */
const hookDecision = z.discriminatedUnion("as", [
  z
    .strictObject({
      as: z
        .literal("build")
        .describe(
          "The hook is compilation: it becomes the Service's build, run once per Deployment. Only a managed Component's preStart can be one.",
        ),
    })
    .describe("Map a preStart hook that only compiles to the Service build."),
  z
    .strictObject({
      as: z
        .literal("replaced")
        .describe(
          "The hook is dropped because something the operator reviewed now does its job.",
        ),
      by: text.describe(
        "What replaces the hook, in the operator's words, such as 'migrations run inside the start command'. Recorded in the manifest.",
      ),
    })
    .describe("Drop a hook whose job something else now does."),
]);
/** The operator's review of one conversion. Every field is a decision Rig refuses to make on its own. */
export const reviewSchema = z
  .strictObject({
    hooks: z
      .record(text, hookDecision)
      .default({})
      .describe(
        "One decision per retired hook, keyed <project>/<component>/<hook>, or <project>/@project/<hook> for a Project-level hook. A hook without a decision blocks the conversion.",
      ),
    ambient: z
      .array(z.enum(["USER", "LOGNAME", "SHELL"]))
      .default([])
      .describe(
        "Inherited variables the old runtime passed to commands and the new one does not. Listing a name accepts that commands naming it no longer receive it unless env sets it.",
      ),
    activate: z
      .array(text)
      .default([])
      .describe(
        "Targets, as <project>/<target>, the operator intends to start after inspection. Recorded in the manifest only; the conversion starts nothing.",
      ),
  })
  .describe("Operator review of a configuration cutover.");
export type Review = z.infer<typeof reviewSchema>;
export type HookDecision = z.infer<typeof hookDecision>;
