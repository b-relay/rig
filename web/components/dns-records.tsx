"use client";

import { useState, type ReactNode } from "react";
import { Cloud, Lock, Pencil, Plus, Search, Trash2 } from "lucide-react";
import {
  DNS_RECORD_TYPES,
  PROXIABLE_TYPES,
  TTL_CHOICES,
  deleteCommand,
  deleteConfirmed,
  draftRecord,
  editable,
  filterRecords,
  recordDraft,
  relativeName,
  saveCommand,
  ttlLabel,
  type RecordDraft,
} from "@/lib/dns";
import type { DnsRecord, DnsRecordType, DnsZone } from "@/lib/types";
import { CARD, Failure, Field, Mono } from "./bits";
import { useRun } from "./operations";
import { runDnsDelete } from "@/server/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** One zone's records: a filter, a row per record (stacked on a phone, columns from md up), and the Add, Edit and Delete
 * dialogs. Each change goes through rigd with the record as it was read, so a record changed meanwhile is refused. */
export function DnsZoneRecords({
  zone,
  records,
}: {
  zone: DnsZone;
  records: readonly DnsRecord[];
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ record?: DnsRecord } | undefined>();
  const [deleting, setDeleting] = useState<DnsRecord>();
  const shown = filterRecords(records, query);
  return (
    <section className={cn("flex min-w-0 flex-col overflow-hidden", CARD)}>
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-3.5 pb-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{zone.name}</h3>
          <p className="text-xs text-muted-foreground">
            {records.length} {records.length === 1 ? "record" : "records"}
            {zone.status !== "active" ? `, zone ${zone.status}` : ""}
          </p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter records"
              aria-label={`Filter the records of ${zone.name}`}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Button size="sm" onClick={() => setEditing({})}>
            <Plus /> Add record
          </Button>
        </div>
      </header>
      {shown.length === 0 ? (
        <p className="border-t px-4 py-6 text-sm text-muted-foreground">
          {records.length
            ? "No record matches the filter."
            : "This zone has no records yet."}
        </p>
      ) : (
        <ul className="divide-y border-t">
          {shown.map((record) => (
            <RecordRow
              key={record.id}
              zone={zone.name}
              record={record}
              onEdit={() => setEditing({ record })}
              onDelete={() => setDeleting(record)}
            />
          ))}
        </ul>
      )}
      {editing ? (
        <RecordDialog
          zone={zone.name}
          shown={records}
          {...(editing.record ? { record: editing.record } : {})}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
      {deleting ? (
        <DeleteDialog
          record={deleting}
          onClose={() => setDeleting(undefined)}
        />
      ) : null}
    </section>
  );
}
/** One record: its name and type, what it holds, its TTL and proxying, and Edit and Delete when Rig manages its type. */
export function RecordRow({
  zone,
  record,
  onEdit,
  onDelete,
}: {
  zone: string;
  record: DnsRecord;
  onEdit(): void;
  onDelete(): void;
}) {
  const managed = editable(record);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-2.5 text-sm md:grid-cols-[minmax(0,1fr)_4rem_minmax(0,1.4fr)_9rem_auto] md:items-center">
      <span className="flex min-w-0 items-center gap-2">
        <Mono
          className="truncate text-[13px] text-foreground"
          title={record.name}
        >
          {relativeName(record.name, zone)}
        </Mono>
        <TypeTag type={record.type} className="md:hidden" />
      </span>
      <span className="hidden md:block">
        <TypeTag type={record.type} />
      </span>
      <span className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:row-start-auto">
        <Mono className="block text-muted-foreground" title={record.content}>
          {record.type === "MX" ? `${record.priority ?? 0} ` : ""}
          {record.content}
        </Mono>
        {record.comment ? (
          <span
            className="block truncate text-xs text-muted-foreground"
            title={record.comment}
          >
            {record.comment}
          </span>
        ) : null}
      </span>
      <span className="col-span-2 row-start-3 flex items-center gap-2 text-xs text-muted-foreground md:col-span-1 md:row-start-auto">
        {record.proxied ? (
          <span
            className="inline-flex items-center gap-1 text-warn"
            title="Answered through Cloudflare's proxy"
          >
            <Cloud className="size-3.5" aria-hidden /> proxied
          </span>
        ) : PROXIABLE_TYPES.includes(record.type as DnsRecordType) ? (
          <span>DNS only</span>
        ) : null}
        <span>TTL {ttlLabel(record.ttl)}</span>
      </span>
      <span className="col-start-2 row-start-1 flex items-center justify-end gap-0.5 md:col-start-auto md:row-start-auto">
        {managed ? (
          <>
            <IconButton
              label={`Edit ${record.type} ${record.name}`}
              onClick={onEdit}
            >
              <Pencil />
            </IconButton>
            <IconButton
              label={`Delete ${record.type} ${record.name}`}
              onClick={onDelete}
            >
              <Trash2 />
            </IconButton>
          </>
        ) : (
          <span
            className="inline-flex size-7 items-center justify-center text-muted-foreground"
            title={`Rig lists ${record.type} records but does not change them`}
          >
            <Lock className="size-3.5" aria-label="read-only" />
          </span>
        )}
      </span>
    </li>
  );
}
function TypeTag({ type, className }: { type: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-md border px-1.5 font-mono text-[11px] font-medium text-muted-foreground",
        className,
      )}
    >
      {type}
    </span>
  );
}
function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}
const CONTENT_HELP: Record<DnsRecordType, string> = {
  A: "An IPv4 address, such as 100.64.0.1.",
  AAAA: "An IPv6 address.",
  CNAME: "The hostname this name is an alias for.",
  TXT: "Text up to 2048 characters, such as v=spf1 -all.",
  MX: "The mail server's hostname.",
  CAA: 'Flags, tag and value, such as 0 issue "letsencrypt.org".',
};
/** Add or edit one record. The type is fixed once a record exists: changing it is a delete and an add. */
export function RecordDialog({
  zone,
  record,
  shown = [],
  onClose,
}: {
  zone: string;
  record?: DnsRecord;
  /** The zone's records as the page read them, so a new record says whether its name and type were free. */
  shown?: readonly DnsRecord[];
  onClose(): void;
}) {
  const [draft, setDraft] = useState<RecordDraft>(() =>
    recordDraft(zone, record),
  );
  const [issues, setIssues] = useState<
    Partial<Record<keyof RecordDraft, string>>
  >({});
  const act = useRun();
  const set = <K extends keyof RecordDraft>(key: K, value: RecordDraft[K]) => {
    setDraft((now) => ({ ...now, [key]: value }));
    setIssues(({ [key]: _gone, ...rest }) => rest);
  };
  const save = async () => {
    const checked = draftRecord(zone, draft);
    if (!checked.ok) {
      setIssues(checked.issues);
      return;
    }
    if (await act.run(saveCommand(zone, checked.record, record, shown)))
      onClose();
  };
  const ttls = TTL_CHOICES.includes(draft.ttl)
    ? TTL_CHOICES
    : [...TTL_CHOICES, draft.ttl];
  const issue = (key: keyof RecordDraft) =>
    issues[key] ? [issues[key]!] : undefined;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {record ? `Edit ${record.type} record` : "Add a record"}
          </DialogTitle>
          <DialogDescription>
            {record
              ? `${record.name}. Saved only if nobody changed it since this page read it.`
              : `A new record in ${zone}.`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <Field label="Type" htmlFor="dns-type">
              <Select
                value={draft.type}
                disabled={record !== undefined}
                onValueChange={(type) => set("type", type as DnsRecordType)}
              >
                <SelectTrigger id="dns-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DNS_RECORD_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="Name"
              htmlFor="dns-name"
              help={`@ for ${zone} itself; * for a wildcard.`}
              issues={issue("name")}
            >
              <div className="flex items-center gap-1.5">
                <Input
                  id="dns-name"
                  value={draft.name}
                  onChange={(event) => set("name", event.target.value)}
                  placeholder="app"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  .{zone}
                </span>
              </div>
            </Field>
          </div>
          <Field
            label="Content"
            htmlFor="dns-content"
            help={CONTENT_HELP[draft.type]}
            issues={issue("content")}
          >
            {draft.type === "TXT" ? (
              <Textarea
                id="dns-content"
                value={draft.content}
                onChange={(event) => set("content", event.target.value)}
                spellCheck={false}
                className="font-mono text-xs"
              />
            ) : (
              <Input
                id="dns-content"
                value={draft.content}
                onChange={(event) => set("content", event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="TTL" htmlFor="dns-ttl" issues={issue("ttl")}>
              <Select
                value={String(draft.ttl)}
                onValueChange={(ttl) => set("ttl", Number(ttl))}
              >
                <SelectTrigger id="dns-ttl" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ttls.map((ttl) => (
                    <SelectItem key={ttl} value={String(ttl)}>
                      {ttlLabel(ttl)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {draft.type === "MX" ? (
              <Field
                label="Priority"
                htmlFor="dns-priority"
                help="Lower is tried first."
                issues={issue("priority")}
              >
                <Input
                  id="dns-priority"
                  inputMode="numeric"
                  value={draft.priority}
                  onChange={(event) => set("priority", event.target.value)}
                />
              </Field>
            ) : null}
          </div>
          {PROXIABLE_TYPES.includes(draft.type) ? (
            <div className="grid gap-1">
              <Label className="gap-2 font-normal">
                <Checkbox
                  checked={draft.proxied}
                  onCheckedChange={(next) => set("proxied", next === true)}
                />
                Proxied through Cloudflare
              </Label>
              <p className="text-xs text-muted-foreground">
                Leave it off for names served by this Mac: Cloudflare&apos;s
                edge cannot reach a Tailscale address.
              </p>
              {issues.proxied ? (
                <p className="text-xs text-bad">{issues.proxied}</p>
              ) : null}
            </div>
          ) : null}
          <Field
            label="Comment"
            htmlFor="dns-comment"
            help="Optional: up to 100 characters on Cloudflare's Free plan, 500 on paid plans. Rig cannot clear a stored comment: emptying this field keeps it."
            issues={issue("comment")}
          >
            <Input
              id="dns-comment"
              value={draft.comment}
              onChange={(event) => set("comment", event.target.value)}
              maxLength={500}
            />
          </Field>
          <Failure failure={act.failure} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={act.busy}>
              {act.busy ? "Saving…" : record ? "Save" : "Add record"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
/** Deleting a record needs its full name typed, as a stray tap must never take a hostname offline. */
export function DeleteDialog({
  record,
  onClose,
}: {
  record: DnsRecord;
  onClose(): void;
}) {
  const [typed, setTyped] = useState("");
  const act = useRun();
  const confirmed = deleteConfirmed(typed, record);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this {record.type} record?</DialogTitle>
          <DialogDescription>
            Resolvers may keep answering with it until its TTL (
            {ttlLabel(record.ttl)}) runs out. Activity records the name and
            type.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1 rounded-md bg-muted px-3 py-2">
          <Mono className="text-[13px] text-foreground">{record.name}</Mono>
          <Mono className="text-muted-foreground">
            {record.type} {record.content}
          </Mono>
        </div>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!confirmed) return;
            void act
              .run(deleteCommand(record, typed), runDnsDelete)
              .then((done) => (done ? onClose() : undefined));
          }}
        >
          <Field
            label={
              <>
                Type <span className="font-mono">{record.name}</span> to confirm
              </>
            }
            htmlFor="dns-delete-confirm"
          >
            <Input
              id="dns-delete-confirm"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          <Failure failure={act.failure} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={!confirmed || act.busy}
            >
              {act.busy ? "Deleting…" : "Delete record"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
