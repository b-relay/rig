import { z } from "zod";
import { commandSchema } from "../../src/daemon/protocol";
import {
  DNS_RECORD_TYPES,
  PROXIABLE_TYPES,
  dnsRecordInputSchema,
  normalizeRecordInput,
  qualifyName,
} from "../../src/domain/dns-records";
import type { DraftCheck, RecordDraft } from "../lib/dns";
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
/** Pure: the draft as the record rigd is asked to write, or each field's problem by its name. It runs here, beside rigd's
 * record rules, so the browser carries none of them. */
export function draftRecord(zone: string, draft: RecordDraft): DraftCheck {
  if (!draft.name.trim())
    return {
      ok: false,
      issues: { name: "Name the record, or type @ for the zone itself." },
    };
  const proxiable = PROXIABLE_TYPES.includes(draft.type);
  const priority = draft.priority.trim();
  if (draft.type === "MX" && !/^\d{1,5}$/.test(priority))
    return {
      ok: false,
      issues: {
        priority: "It must be a whole number from 0 to 65535, such as 10.",
      },
    };
  const parsed = dnsRecordInputSchema.safeParse({
    name: qualifyName(draft.name, zone),
    type: draft.type,
    content: draft.content.trim(),
    ttl: draft.ttl,
    ...(proxiable ? { proxied: draft.proxied } : {}),
    ...(draft.type === "MX" ? { priority: Number(priority) } : {}),
    ...(draft.comment.trim() ? { comment: draft.comment.trim() } : {}),
  });
  if (parsed.success)
    return { ok: true, record: normalizeRecordInput(parsed.data) };
  const issues: Partial<Record<keyof RecordDraft, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? "content") as keyof RecordDraft;
    issues[field] ??=
      `${field === "name" ? "The name" : "It"} ${issue.message}.`;
  }
  return { ok: false, issues };
}
/** What the record dialog sends to have its draft checked: the zone and every field as typed. */
const draftCheckRequestSchema = z.strictObject({
  zone: z.string().min(1),
  draft: z.strictObject({
    type: z.enum(DNS_RECORD_TYPES),
    name: z.string(),
    content: z.string(),
    ttl: z.number(),
    proxied: z.boolean(),
    priority: z.string(),
    comment: z.string(),
  }),
});
/** Pure: the check of the draft a browser sent, or undefined when what it sent is not a zone and a draft. */
export function checkedDraft(input: unknown): DraftCheck | undefined {
  const request = draftCheckRequestSchema.safeParse(input);
  return request.success
    ? draftRecord(request.data.zone, request.data.draft)
    : undefined;
}
