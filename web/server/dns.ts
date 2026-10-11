import { commandSchema } from "../../src/daemon/protocol";
import type { Failure } from "../lib/outcome";
import type { RuntimeCommand } from "../lib/types";

/** The refusal `runCommand` answers a dns-delete with: a delete goes only through `runDnsDelete`. */
export const DNS_DELETE_ELSEWHERE: Failure = {
  code: "DNS_CONFIRMATION",
  message: "Deleting a DNS record needs its name typed to confirm.",
  hint: "Use Delete beside the record on the Proxy page, which asks for its name.",
};
/** Pure: the dns-delete a page sent, when it carries everything a delete needs: the record as the page read it and the
 * name the person typed. rigd compares that name with the record it reads just before deleting, so the check holds
 * whatever page or script sent it. */
export function confirmedDnsDelete(
  input: unknown,
): { ok: true; command: RuntimeCommand } | { ok: false; failure: Failure } {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success || parsed.data.action !== "dns-delete")
    return {
      ok: false,
      failure: {
        code: "INVALID_REQUEST",
        message:
          "The browser sent a DNS delete rigd's grammar does not accept.",
        hint: "Reload the dashboard; its build may be older than rigd.",
      },
    };
  const dns = parsed.data.dns;
  if (!dns?.zone || !dns.id || !dns.modifiedOn || !dns.confirm?.trim())
    return {
      ok: false,
      failure: {
        code: "DNS_CONFIRMATION",
        message:
          "Deleting a DNS record needs the record, as read, and its name typed to confirm.",
        hint: "Type the record's full name in the Delete dialog.",
      },
    };
  return { ok: true, command: parsed.data };
}
