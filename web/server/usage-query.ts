import { z } from "zod";
import { MAX_NAME_LENGTH } from "../../src/domain/names";
import { USAGE_RANGES } from "../../src/domain/usage-summary";

const range = z
  .enum(USAGE_RANGES)
  .describe(
    "The preset the chart covers: 1h, 24h or 7d. It is resolved to a window at every poll, so the chart always ends now.",
  );
/** What a Monitor page polls (`/usage?q=`, as JSON): the whole Host, or one Project with the Target whose Components it
 * charts (`all` for none), over a preset. Server-only, since a route file exports nothing else. */
export const usageQuerySchema = z.union([
  z.strictObject({
    host: z
      .literal(true)
      .describe(
        "Always true: the poll reads the whole Host, as the Host Monitor page shows it (every Project's total, Rig itself and the Host), rather than one Project.",
      ),
    range,
  }),
  z.strictObject({
    project: z
      .string()
      .describe(
        "The name of the registered Project whose CPU and memory the poll reads, as its Monitor page is addressed. rigd's command grammar checks it; a poll it refuses answers INVALID_REQUEST.",
      ),
    target: z
      .string()
      .min(1)
      .max(MAX_NAME_LENGTH)
      .describe(
        "The Target the page charts, by name: only its Components' series are sent, beside the Project's and each Target's totals. `all` sends no Component's. It must be a Target the Project has now or one whose history the range still holds (a destroyed Preview); any other answers TARGET_MISSING.",
      ),
    range,
  }),
]);
