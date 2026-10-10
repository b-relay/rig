"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Plus, X } from "lucide-react";
import type {
  ConfigChange,
  ConfigField,
  ConfigPatch,
  ConfigRead,
  ConfigReport,
} from "@/lib/types";
import type {
  ConfigIssue,
  Failure as FailureShape,
  Outcome,
} from "@/lib/outcome";
import { transportFailure } from "@/lib/reconcile";
import { runConfigEdit } from "@/server/actions";
import {
  applyPatch,
  configPatch,
  fieldFor,
  getAt,
  isTree,
  KEY_PATTERN,
  keyAllowed,
  parseLines,
  parseList,
  parsePort,
  removeAt,
  removeRoleSetting,
  roleOn,
  setAt,
  showLines,
  switchRole,
  type TargetRole,
  type Tree,
} from "@/lib/config-form";
import {
  Empty,
  Failure,
  Field,
  Mono,
  Notice,
  Section,
} from "@/components/bits";
import { Confirm } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface Draft {
  tree: Tree;
  fields: readonly ConfigField[];
  /** What rigd's last review found wrong, by dotted field path. */
  issues: readonly ConfigIssue[];
  set(path: string[], value: unknown): void;
  remove(path: string[]): void;
  /** Replaces the draft with what `change` makes of it. */
  update(change: (tree: Tree) => Tree): void;
}
const DraftContext = createContext<Draft | undefined>(undefined);
function useDraft(): Draft {
  const draft = useContext(DraftContext);
  if (!draft) throw new Error("Config controls render inside the editor.");
  return draft;
}
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROXY_PREFIX = /^\/[A-Za-z0-9._~/-]*$/;
const SECTIONS = [
  ["project", "Project"],
  ["environment", "Environment"],
  ["services", "Services"],
  ["tools", "Tools"],
  ["proxy", "Proxy"],
  ["targets", "Targets"],
] as const;
type Section = (typeof SECTIONS)[number][0];
const shown = (value: unknown) =>
  value === undefined
    ? "—"
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);

/** The structured editor for one Project's rig.yaml. The server page reads the file and hands it
 * over; every refresh hands over the current revision, and the draft follows it unless edits
 * are pending, in which case they are replayed on top. */
export function ConfigEditor({
  project,
  source,
  validated,
}: {
  project: string;
  source: ConfigRead;
  validated: Outcome<ConfigReport>;
}) {
  const router = useRouter();
  const [change, setChange] = useState<{
    busy: boolean;
    failure?: FailureShape;
    result?: ConfigChange;
  }>({ busy: false });
  const [tree, setTree] = useState<Tree>(() =>
    isTree(source.config) ? source.config : {},
  );
  const [section, setSection] = useState<Section>("project");
  const [reviewing, setReviewing] = useState(false);
  const [rebased, setRebased] = useState(false);
  const original = source.config;
  const revision = source.revision;
  // A read of another revision replaces the draft, so a refresh after apply shows what rigd wrote;
  // after a revision conflict the outstanding edits are replayed onto the newer file instead.
  const pendingEdits = useRef<ConfigPatch[] | undefined>(undefined);
  const seen = useRef(revision);
  useEffect(() => {
    if (seen.current === revision && pendingEdits.current === undefined) return;
    seen.current = revision;
    if (isTree(original))
      setTree(applyPatch(original, pendingEdits.current ?? []));
    pendingEdits.current = undefined;
  }, [revision, original]);
  const patch = useMemo(
    () => (isTree(original) ? configPatch(original, tree) : []),
    [original, tree],
  );
  // rigd checks the draft against the schema a moment after typing stops, so a field's problem shows
  // beneath it before anything is reviewed; a review's own answer takes over once there is one.
  const [checked, setChecked] = useState<{
    patch: string;
    issues: readonly ConfigIssue[];
    /** rig.yaml changed on disk since this page read it, so no check can speak until it is read again. */
    stale?: true;
  }>({ patch: "[]", issues: [] });
  const patchText = JSON.stringify(patch);
  // A review's problems describe the draft it saw; once the draft changes, the next check speaks.
  useEffect(() => {
    setChange((now) => (now.failure?.issues ? { busy: now.busy } : now));
  }, [patchText]);
  useEffect(() => {
    if (patch.length === 0) return;
    let current = true;
    const timer = setTimeout(() => {
      void runConfigEdit({
        action: "preview",
        project,
        expectedRevision: revision,
        patch: JSON.parse(patchText) as ConfigPatch[],
      })
        .then((outcome) => {
          if (current)
            setChecked({
              patch: patchText,
              issues: outcome.ok ? [] : (outcome.failure.issues ?? []),
              ...(!outcome.ok &&
              outcome.failure.code.toUpperCase() === "REVISION_CONFLICT"
                ? { stale: true as const }
                : {}),
            });
        })
        .catch(() => {});
    }, 700);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [patchText, patch.length, project, revision]);
  const issues = useMemo(
    () =>
      change.failure?.issues ??
      (patch.length && checked.patch === patchText ? checked.issues : []),
    [change.failure, checked, patch.length, patchText],
  );
  const draft = useMemo<Draft>(
    () => ({
      tree,
      fields: source.fields,
      issues,
      set: (path, value) => setTree((current) => setAt(current, path, value)),
      remove: (path) => setTree((current) => removeAt(current, path)),
      update: (change) => setTree(change),
    }),
    [tree, source.fields, issues],
  );
  const send = async (action: "preview" | "apply") => {
    setChange({ busy: true });
    let outcome: Outcome<unknown>;
    try {
      outcome = await runConfigEdit({
        action,
        project,
        expectedRevision: revision,
        patch,
      });
    } catch (error) {
      outcome = { ok: false, failure: transportFailure(error) };
    }
    if (outcome.ok) {
      const result = outcome.value as ConfigChange;
      setChange({ busy: false, result });
      if (action === "preview") setReviewing(true);
      if (result.applied) {
        setRebased(false);
        setReviewing(false);
        router.refresh();
      }
      return;
    }
    // rig.yaml changed under the draft: read it again without dropping the edits.
    if (outcome.failure.code.toUpperCase() === "REVISION_CONFLICT") {
      pendingEdits.current = patch;
      setRebased(true);
      setReviewing(false);
      setChange({ busy: false });
      router.refresh();
      return;
    }
    setChange({ busy: false, failure: outcome.failure });
  };
  const discard = () => {
    if (isTree(original)) setTree(original);
    setRebased(false);
    setChange({ busy: false });
  };
  return (
    <DraftContext.Provider value={draft}>
      <Section
        title="Configuration"
        description={
          <Mono>
            {source.configPath}, revision {source.revision.slice(0, 12)}
          </Mono>
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={patch.length === 0 || change.busy}
              onClick={discard}
            >
              Discard
            </Button>
            <Button
              size="sm"
              disabled={patch.length === 0 || change.busy}
              onClick={() => void send("preview")}
            >
              {change.busy ? "Checking…" : `Review ${patch.length || ""}`}
              {patch.length === 1 ? " change" : " changes"}
            </Button>
          </>
        }
      >
        {change.result?.applied && patch.length === 0 ? (
          <Notice tone="good">
            Applied. A backup is at {change.result.backupPath}.
          </Notice>
        ) : null}
        {rebased ? (
          <Notice tone="warn">
            rig.yaml changed since you started editing. It was read again and
            your edits re-applied on top; review them before applying.
          </Notice>
        ) : null}
        {checked.stale && checked.patch === patchText && !rebased ? (
          <Notice tone="warn">
            rig.yaml changed on disk since this page read it. Review your
            changes to read it again; your edits are kept and re-applied on top.
          </Notice>
        ) : null}
        {reviewing ? null : (
          <>
            {issues.length ? (
              <IssueList
                issues={issues}
                hint={change.failure?.hint}
                onShow={(section) => setSection(section)}
              />
            ) : null}
            {/* A review that failed for another reason says so even while the live check lists problems. */}
            {change.failure && !change.failure.issues ? (
              <Failure failure={change.failure} />
            ) : null}
          </>
        )}
        <Tabs
          value={section}
          onValueChange={(next) => setSection(next as Section)}
        >
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <TabsList variant="line" className="w-max">
              {SECTIONS.map(([value, label]) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                  {issuesIn(issues, value) ? (
                    <span className="size-1.5 rounded-full bg-bad">
                      <span className="sr-only">has problems</span>
                    </span>
                  ) : changedIn(patch, value) ? (
                    <span className="size-1.5 rounded-full bg-warn">
                      <span className="sr-only">changed</span>
                    </span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>
        {section === "project" ? (
          <ProjectSection />
        ) : section === "environment" ? (
          <EnvironmentSection path={[]} />
        ) : section === "services" ? (
          <Entries kind="service" />
        ) : section === "tools" ? (
          <Entries kind="tool" />
        ) : section === "proxy" ? (
          <ProxySection path={["proxy"]} />
        ) : (
          <TargetsSection />
        )}
      </Section>
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
          rig.yaml as written
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 flex flex-col gap-2">
          <Source text={source.raw} />
          {validated.ok ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                As rigd resolves it
              </summary>
              <Source text={JSON.stringify(validated.value.config, null, 2)} />
            </details>
          ) : (
            <Failure failure={validated.failure} />
          )}
        </CollapsibleContent>
      </Collapsible>
      <Dialog
        open={reviewing}
        onOpenChange={(open) => {
          setReviewing(open);
          if (!open) setChange({ busy: false });
        }}
      >
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Review changes</DialogTitle>
            <DialogDescription>
              rigd checked these edits against the schema. Applying rewrites
              rig.yaml, keeps comments and ordering, and leaves a rig.yaml.bak
              backup.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Failure failure={change.failure} />
            {change.result ? (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Field</TableHead>
                      <TableHead>Before</TableHead>
                      <TableHead>After</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {change.result.diff.map((row) => (
                      <TableRow key={row.path}>
                        <TableCell className="font-mono text-xs">
                          {row.path}
                        </TableCell>
                        <TableCell className="font-mono text-xs break-all whitespace-pre-wrap text-bad line-through">
                          {shown(row.before)}
                        </TableCell>
                        <TableCell className="font-mono text-xs break-all whitespace-pre-wrap text-good">
                          {shown(row.after)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer text-muted-foreground">
                    Resulting rig.yaml
                  </summary>
                  <Source text={change.result.raw} />
                </details>
              </>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewing(false)}>
              Keep editing
            </Button>
            <Button
              disabled={change.busy || !change.result}
              onClick={() => void send("apply")}
            >
              {change.busy ? "Applying…" : "Apply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DraftContext.Provider>
  );
}
const SECTION_ROOTS: Record<Section, readonly string[]> = {
  project: [
    "name",
    "description",
    "production_branch",
    "domain",
    "build",
    "build_timeout",
  ],
  environment: ["environment", "env_file"],
  services: ["services"],
  tools: ["tools"],
  proxy: ["proxy"],
  targets: ["targets"],
};
const changedIn = (patch: { path: string[] }[], section: Section) =>
  patch.some((edit) => SECTION_ROOTS[section].includes(edit.path[0] ?? ""));
/** The section a dotted field path belongs to; the Project section holds whatever no other claims. */
const sectionOf = (path: string): Section =>
  SECTIONS.map(([value]) => value).find((section) =>
    SECTION_ROOTS[section].includes(path.split(".")[0] ?? ""),
  ) ?? "project";
const issuesIn = (issues: readonly ConfigIssue[], section: Section) =>
  issues.some((issue) => sectionOf(issue.path) === section);
/** What rigd's review found wrong, each problem with a link to the section its field is in; each
 * field shows its own problem beneath it too. */
function IssueList({
  issues,
  hint,
  onShow,
}: {
  issues: readonly ConfigIssue[];
  hint: string | undefined;
  onShow(section: Section): void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-bad/40 bg-bad-fill px-4 py-3 text-sm"
    >
      <p className="font-medium text-bad">
        rig.yaml would not be valid with these changes:
      </p>
      <ul className="flex flex-col gap-1">
        {issues.map((issue) => (
          <li key={`${issue.path}:${issue.message}`} className="flex gap-2">
            <button
              type="button"
              className="font-mono text-xs text-link hover:underline"
              onClick={() => onShow(sectionOf(issue.path))}
            >
              {issue.path || "rig.yaml"}
            </button>
            <span>{issue.message}</span>
          </li>
        ))}
      </ul>
      {hint && issues.length > 3 ? (
        <p className="text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
function Source({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-pane p-3 font-mono text-xs leading-5 whitespace-pre text-on-pane">
      {text}
    </pre>
  );
}

/* Bound controls: each reads and writes one path of the draft and shows the schema's help for it. */

function useHelp(path: string[]): string | undefined {
  const { fields } = useDraft();
  return fieldFor(fields, path)?.description;
}
/** The problems rigd's last review found with this exact field. */
function useIssues(path: readonly string[]): string[] {
  const { issues } = useDraft();
  const dotted = path.join(".");
  return issues
    .filter((issue) => issue.path === dotted)
    .map((issue) => issue.message);
}
function Text({
  path,
  label,
  required = false,
  mono = false,
  placeholder,
  disabled = false,
  help,
}: {
  path: string[];
  label: string;
  required?: boolean;
  mono?: boolean;
  placeholder?: string;
  disabled?: boolean;
  help?: ReactNode;
}) {
  const draft = useDraft();
  const value = getAt(draft.tree, path);
  const id = path.join(".");
  const schemaHelp = useHelp(path);
  return (
    <Field
      label={label}
      htmlFor={id}
      help={help ?? schemaHelp}
      issues={useIssues(path)}
    >
      <Input
        id={id}
        value={typeof value === "string" ? value : ""}
        placeholder={placeholder}
        disabled={disabled}
        className={mono ? "font-mono text-xs" : undefined}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "" && !required) draft.remove(path);
          else draft.set(path, next);
        }}
      />
    </Field>
  );
}
const UNSET = "__unset";
/** A setting with a closed set of values. With `defaultOption`, each value is listed once: an absent
 * setting shows the default as a placeholder, picking any value (the default too) writes it, and
 * "Unset" removes it again. With `unsetLabel`, absence is a choice of its own in the list. */
function Choice({
  path,
  label,
  options,
  ...absence
}: {
  path: string[];
  label: string;
  options: readonly string[];
} & ({ unsetLabel: string } | { defaultOption: string })) {
  const draft = useDraft();
  const value = getAt(draft.tree, path);
  const id = path.join(".");
  const chosen = typeof value === "string" ? value : undefined;
  const byDefault = "defaultOption" in absence;
  const text = (option: string) =>
    byDefault && option === absence.defaultOption
      ? `${option} (default)`
      : option;
  return (
    <Field
      label={label}
      htmlFor={id}
      help={useHelp(path)}
      issues={useIssues(path)}
    >
      <div className="flex gap-2">
        <Select
          // Radix reports no change when the shown value is picked again, so an absent setting
          // selects nothing: picking the default then counts as the write it is.
          value={chosen ?? (byDefault ? "" : UNSET)}
          onValueChange={(next) =>
            next === UNSET ? draft.remove(path) : draft.set(path, next)
          }
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue
              placeholder={byDefault ? text(absence.defaultOption) : undefined}
            />
          </SelectTrigger>
          <SelectContent>
            {byDefault ? null : (
              <SelectItem value={UNSET}>{absence.unsetLabel}</SelectItem>
            )}
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {text(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {byDefault && chosen !== undefined ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => draft.remove(path)}
          >
            Unset
          </Button>
        ) : null}
      </div>
    </Field>
  );
}
/** Text for a list field: the typed text while it has focus (so a trailing comma or blank line
 * survives), the draft's own value otherwise, so Discard and reloads show through. */
function useListText(shownValue: string) {
  const [typed, setTyped] = useState<string>();
  return {
    text: typed ?? shownValue,
    onFocus: () => setTyped(shownValue),
    onBlur: () => setTyped(undefined),
    setTyped,
  };
}
function ListText({ path, label }: { path: string[]; label: string }) {
  const draft = useDraft();
  const value = getAt(draft.tree, path);
  const field = useListText(
    Array.isArray(value) ? value.map(String).join(", ") : "",
  );
  const id = path.join(".");
  return (
    <Field
      label={label}
      htmlFor={id}
      help={useHelp(path)}
      issues={useIssues(path)}
    >
      <Input
        id={id}
        value={field.text}
        placeholder="db, cache"
        onFocus={field.onFocus}
        onBlur={field.onBlur}
        onChange={(event) => {
          field.setTyped(event.target.value);
          const items = parseList(event.target.value);
          if (items.length) draft.set(path, items);
          else draft.remove(path);
        }}
      />
    </Field>
  );
}
function Lines({ path, label }: { path: string[]; label: string }) {
  const draft = useDraft();
  const field = useListText(showLines(getAt(draft.tree, path)));
  const id = path.join(".");
  const schemaHelp = useHelp(path);
  return (
    <Field
      label={label}
      htmlFor={id}
      issues={useIssues(path)}
      help={
        <>One file per line, relative to the workspace. {schemaHelp ?? ""}</>
      }
    >
      <Textarea
        id={id}
        value={field.text}
        rows={2}
        placeholder=".env"
        className="font-mono text-xs"
        onFocus={field.onFocus}
        onBlur={field.onBlur}
        onChange={(event) => {
          field.setTyped(event.target.value);
          const parsed = parseLines(event.target.value);
          if (parsed === undefined) draft.remove(path);
          else draft.set(path, parsed);
        }}
      />
    </Field>
  );
}
/** A record of scalar values: each key gets an input and a remove button; new keys are added by name. */
function Records({
  path,
  label,
  keyLabel,
  keyPattern,
  keyPlaceholder,
  valueKind,
  valuePlaceholder,
  initial,
}: {
  path: string[];
  label: string;
  keyLabel: string;
  keyPattern: RegExp;
  keyPlaceholder: string;
  valueKind: "text" | "port";
  valuePlaceholder?: string;
  initial: string;
}) {
  const draft = useDraft();
  const record = getAt(draft.tree, path);
  const entries = isTree(record) ? Object.entries(record) : [];
  const [newKey, setNewKey] = useState("");
  const entryHelp = useHelp([...path, "*"]);
  const recordHelp = useHelp(path);
  const help = entryHelp ?? recordHelp;
  const recordIssues = useIssues(path);
  const entryIssues = (key: string) =>
    draft.issues
      .filter((issue) => issue.path === [...path, key].join("."))
      .map((issue) => issue.message);
  const valid = keyAllowed(
    keyPattern,
    newKey,
    entries.map(([key]) => key),
  );
  const add = () => {
    if (!valid) return;
    draft.set(
      [...path, newKey],
      valueKind === "port" ? parsePort(initial) : initial,
    );
    setNewKey("");
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium">{label}</div>
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
      {recordIssues.map((issue) => (
        <p key={issue} role="alert" className="text-xs text-bad">
          {issue}
        </p>
      ))}
      {entries.length === 0 ? <Empty>None.</Empty> : null}
      {entries.map(([key, value]) => (
        <div
          key={key}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
        >
          <Mono className="truncate sm:col-span-1" title={key}>
            {key}
          </Mono>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${key}`}
            className="sm:order-last"
            onClick={() => draft.remove([...path, key])}
          >
            <X />
          </Button>
          <Input
            aria-label={`${label} ${key}`}
            aria-invalid={entryIssues(key).length ? true : undefined}
            value={String(value)}
            placeholder={valuePlaceholder}
            className="col-span-2 font-mono text-xs sm:col-span-1"
            inputMode={valueKind === "port" ? "numeric" : undefined}
            onChange={(event) =>
              draft.set(
                [...path, key],
                valueKind === "port"
                  ? parsePort(event.target.value)
                  : event.target.value,
              )
            }
          />
          {entryIssues(key).map((issue) => (
            <p
              key={issue}
              role="alert"
              className="col-span-2 text-xs text-bad sm:col-span-3"
            >
              {issue}
            </p>
          ))}
        </div>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input
          aria-label={`New ${keyLabel}`}
          value={newKey}
          placeholder={keyPlaceholder}
          className="max-w-xs font-mono text-xs"
          onChange={(event) => setNewKey(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={!valid}>
          <Plus /> Add
        </Button>
      </form>
    </div>
  );
}

/* Sections. */

function ProjectSection() {
  const draft = useDraft();
  const name = getAt(draft.tree, ["name"]);
  return (
    <div className="grid max-w-xl gap-4">
      <Text
        path={["name"]}
        label="Name"
        required
        disabled
        help="Renaming happens under Settings so registration and routes stay coherent."
      />
      <Text path={["description"]} label="Description" />
      <Text
        path={["production_branch"]}
        label="Production Branch"
        placeholder="main"
        mono
      />
      <Text
        path={["domain"]}
        label="Domain"
        placeholder={`${typeof name === "string" ? name : "app"}.example.com`}
      />
      <Text path={["build"]} label="Build command" mono />
      <Text
        path={["build_timeout"]}
        label="Build timeout"
        placeholder="10m"
        mono
      />
    </div>
  );
}
function EnvironmentSection({ path }: { path: string[] }) {
  return (
    <div className="grid max-w-xl gap-6">
      <Records
        path={[...path, "environment"]}
        label="Environment variables"
        keyLabel="variable"
        keyPattern={ENV_NAME}
        keyPlaceholder="LOG_LEVEL"
        valueKind="text"
        initial=""
      />
      <Lines path={[...path, "env_file"]} label="Environment files" />
    </div>
  );
}
function ServiceFields({
  path,
  required,
}: {
  path: string[];
  required: boolean;
}) {
  return (
    <div className="grid gap-4">
      <Text
        path={[...path, "command"]}
        label="Command"
        required={required}
        mono
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {required ? (
          <Text path={[...path, "build"]} label="Build command" mono />
        ) : (
          <PatchBuild path={[...path, "build"]} />
        )}
        <Text path={[...path, "working_dir"]} label="Working directory" mono />
        <Text
          path={[...path, "build_timeout"]}
          label="Build timeout"
          placeholder="10m"
          mono
        />
        <ListText path={[...path, "depends_on"]} label="Depends on" />
        <Choice
          path={[...path, "restart"]}
          label="Restart"
          defaultOption="always"
          options={["always", "on-failure", "no"]}
        />
      </div>
      <Records
        path={[...path, "ports"]}
        label="Ports"
        keyLabel="port name"
        keyPattern={KEY_PATTERN}
        keyPlaceholder="http"
        valueKind="port"
        valuePlaceholder="auto"
        initial="auto"
      />
      <HealthcheckFields path={[...path, "healthcheck"]} />
      <EnvironmentSection path={path} />
    </div>
  );
}
/** A Service's healthcheck, in Docker Compose's shape. A list-form test (CMD, CMD-SHELL, NONE) is shown, not edited, so
 * the form never rewrites it as a string. */
function HealthcheckFields({ path }: { path: string[] }) {
  const draft = useDraft();
  const test = getAt(draft.tree, [...path, "test"]);
  const disabled = getAt(draft.tree, [...path, "disable"]) === true;
  const retries = getAt(draft.tree, [...path, "retries"]);
  return (
    <div className="grid gap-4 rounded-md border p-4">
      <div className="text-sm font-medium">Healthcheck</div>
      {Array.isArray(test) ? (
        <Field
          label="Test"
          htmlFor={[...path, "test"].join(".")}
          help="A list form; edit it in rig.yaml."
        >
          <Input
            id={[...path, "test"].join(".")}
            value={JSON.stringify(test)}
            disabled
            className="font-mono text-xs"
          />
        </Field>
      ) : (
        <Text
          path={[...path, "test"]}
          label="Test"
          placeholder="http://127.0.0.1:${port}/health"
          mono
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Text
          path={[...path, "interval"]}
          label="Interval"
          placeholder="30s"
          mono
        />
        <Text
          path={[...path, "timeout"]}
          label="Timeout"
          placeholder="30s"
          mono
        />
        <Field
          label="Retries"
          htmlFor={[...path, "retries"].join(".")}
          help={useHelp([...path, "retries"])}
          issues={useIssues([...path, "retries"])}
        >
          <Input
            id={[...path, "retries"].join(".")}
            value={typeof retries === "number" ? String(retries) : ""}
            placeholder="3"
            inputMode="numeric"
            className="font-mono text-xs"
            onChange={(event) => {
              const next = event.target.value.trim();
              if (next === "") draft.remove([...path, "retries"]);
              else
                draft.set(
                  [...path, "retries"],
                  /^\d+$/.test(next) ? Number(next) : next,
                );
            }}
          />
        </Field>
        <Text
          path={[...path, "start_period"]}
          label="Start period"
          placeholder="30s"
          mono
        />
        <Choice
          path={[...path, "on_failure"]}
          label="On failure"
          defaultOption="report"
          options={["report", "restart"]}
        />
      </div>
      <Label className="gap-2 font-normal">
        <Switch
          checked={disabled}
          onCheckedChange={(next) =>
            next
              ? draft.set([...path, "disable"], true)
              : draft.remove([...path, "disable"])
          }
        />
        Disable the healthcheck
      </Label>
    </div>
  );
}
function ToolFields({ path, required }: { path: string[]; required: boolean }) {
  return (
    <div className="grid gap-4">
      <Text
        path={[...path, "bin"]}
        label="Executable"
        required={required}
        mono
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Text path={[...path, "build"]} label="Build command" mono />
        <Text
          path={[...path, "build_timeout"]}
          label="Build timeout"
          placeholder="10m"
          mono
        />
      </div>
    </div>
  );
}
const ENTRY = {
  service: {
    root: "services",
    title: "Service",
    initial: { command: "" },
    Fields: ServiceFields,
  },
  tool: {
    root: "tools",
    title: "Tool",
    initial: { bin: "" },
    Fields: ToolFields,
  },
} as const;
/** The Services or Tools record: a card per entry plus a name field that adds one. */
function Entries({ kind }: { kind: keyof typeof ENTRY }) {
  const draft = useDraft();
  const { root, title, initial, Fields } = ENTRY[kind];
  const record = getAt(draft.tree, [root]);
  const names = isTree(record) ? Object.keys(record) : [];
  const [newName, setNewName] = useState("");
  const help = useHelp([root]);
  const taken = [
    ...Object.keys(getAt(draft.tree, ["services"]) ?? {}),
    ...Object.keys(getAt(draft.tree, ["tools"]) ?? {}),
  ];
  const valid = keyAllowed(KEY_PATTERN, newName, taken);
  return (
    <div className="flex flex-col gap-4">
      {help ? <p className="text-sm text-muted-foreground">{help}</p> : null}
      {names.length === 0 ? <Empty>No {title}s yet.</Empty> : null}
      {names.map((name) => (
        <EntryCard
          key={name}
          title={name}
          onRemove={() => draft.remove([root, name])}
          removeQuestion={`Remove ${title} ${name}?`}
        >
          <Fields path={[root, name]} required />
        </EntryCard>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          draft.set([root, newName], { ...initial });
          setNewName("");
        }}
      >
        <Input
          aria-label={`New ${title} name`}
          value={newName}
          placeholder={kind === "service" ? "web" : "cli"}
          className="max-w-xs font-mono text-xs"
          onChange={(event) => setNewName(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={!valid}>
          <Plus /> Add {title}
        </Button>
      </form>
    </div>
  );
}
function EntryCard({
  title,
  onRemove,
  removeQuestion,
  children,
}: {
  title: string;
  onRemove(): void;
  removeQuestion: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-t border-rule pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-mono text-sm font-semibold">{title}</h3>
        <Confirm
          title={removeQuestion}
          description="It leaves rig.yaml when you apply; running Targets keep it until they are redeployed or restarted."
          confirmLabel="Remove"
          destructive
          onConfirm={onRemove}
        >
          <Button variant="ghost" size="sm">
            <X /> Remove
          </Button>
        </Confirm>
      </div>
      {children}
    </div>
  );
}
function ProxySection({ path }: { path: string[] }) {
  const draft = useDraft();
  const services = getAt(draft.tree, ["services"]);
  // A Service name means its only port; a Service with several ports needs one named.
  const first = isTree(services)
    ? Object.keys(services).find((name) => {
        const ports = getAt(services, [name, "ports"]);
        return isTree(ports) && Object.keys(ports).length > 0;
      })
    : undefined;
  const ports = first ? getAt(services, [first, "ports"]) : undefined;
  const names = isTree(ports) ? Object.keys(ports) : [];
  const upstream = !first
    ? ""
    : names.length === 1
      ? first
      : `\${services.${first}.ports.${names[0]}}`;
  return (
    <div className="max-w-xl">
      <Records
        path={path}
        label="Path prefixes"
        keyLabel="prefix"
        keyPattern={PROXY_PREFIX}
        keyPlaceholder="/api"
        valueKind="text"
        valuePlaceholder="web"
        initial={upstream}
      />
    </div>
  );
}
const ROLES: readonly TargetRole[] = ["working", "stable", "preview"];
function TargetsSection() {
  const draft = useDraft();
  const [role, setRole] = useState<TargetRole>("working");
  const path = ["targets", role];
  const services = Object.keys(getAt(draft.tree, ["services"]) ?? {});
  const tools = Object.keys(getAt(draft.tree, ["tools"]) ?? {});
  const on = roleOn(draft.tree, role);
  // Clearing a role's last setting keeps the role on rather than removing its key, which would turn it off.
  const scoped = useMemo<Draft>(
    () => ({
      ...draft,
      remove: (removed) =>
        draft.update((tree) => removeRoleSetting(tree, role, removed)),
    }),
    [draft, role],
  );
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        A Target runs only when it is on, and a role left out of targets is off.
        Each role patches the Project settings for its Targets: maps merge per
        key, lists and scalars replace.
      </p>
      <Tabs value={role} onValueChange={(next) => setRole(next as TargetRole)}>
        <TabsList>
          {ROLES.map((value) => (
            <TabsTrigger key={value} value={value}>
              {value}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Label className="gap-2 font-normal">
        <Switch
          checked={on}
          onCheckedChange={(next) =>
            draft.update((tree) => switchRole(tree, role, next))
          }
        />
        {role === "preview" ? "Previews are on" : `${role} is on`}
      </Label>
      {on ? (
        <DraftContext.Provider value={scoped}>
          <TargetSettings
            key={role}
            path={path}
            services={services}
            tools={tools}
            preview={role === "preview"}
          />
        </DraftContext.Provider>
      ) : (
        <p className="text-sm text-muted-foreground">
          Turning it on lets rig up, deploy and the dashboard run it. Turning a
          role off drops its settings from rig.yaml.
        </p>
      )}
    </div>
  );
}
function TargetSettings({
  path,
  services,
  tools,
  preview,
}: {
  path: string[];
  services: readonly string[];
  tools: readonly string[];
  preview: boolean;
}) {
  return (
    <>
      <div className="grid max-w-xl gap-4">
        <Text
          path={[...path, "domain"]}
          label="Domain"
          placeholder={preview ? "${rig.target}.preview.app.test" : undefined}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <PatchBuild path={[...path, "build"]} />
          <Text
            path={[...path, "build_timeout"]}
            label="Build timeout"
            placeholder="10m"
            mono
          />
        </div>
        <EnvironmentSection path={path} />
        <ProxySection path={[...path, "proxy"]} />
        {services.map((name) => (
          <Override key={`s:${name}`} title={`Service ${name}`}>
            <ServiceFields
              path={[...path, "services", name]}
              required={false}
            />
          </Override>
        ))}
        {tools.map((name) => (
          <Override key={`t:${name}`} title={`Tool ${name}`}>
            <ToolFields path={[...path, "tools", name]} required={false} />
          </Override>
        ))}
      </div>
    </>
  );
}
/** A build in a Target patch: a command that replaces the inherited one, or `false`, which turns it off for the role. */
function PatchBuild({ path }: { path: string[] }) {
  const draft = useDraft();
  const off = getAt(draft.tree, path) === false;
  return (
    <div className="grid gap-2">
      <Text path={path} label="Build command" mono disabled={off} />
      <Label className="gap-2 font-normal">
        <Switch
          checked={off}
          onCheckedChange={(next) =>
            next ? draft.set(path, false) : draft.remove(path)
          }
        />
        No build for this role
      </Label>
    </div>
  );
}
function Override({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Collapsible className="rounded-md border">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 p-3 text-left text-sm font-medium">
        <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
        {title} overrides
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t p-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
