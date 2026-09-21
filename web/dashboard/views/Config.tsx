import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronRight, Plus, X } from "lucide-react";
import type { ConfigChange, ConfigField, ConfigPatch } from "../types";
import { useAct, useApi, useRead } from "../hooks";
import { RigdError } from "../api";
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
  setAt,
  showLines,
  type Tree,
} from "../config-form";
import { Confirm, Empty, Failure, Field, Mono, Notice, Panel } from "../ui";
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
import { Textarea } from "@/components/ui/textarea";

interface Draft {
  tree: Tree;
  fields: readonly ConfigField[];
  set(path: string[], value: unknown): void;
  remove(path: string[]): void;
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

export function Config({ project }: { project: string }) {
  const api = useApi();
  const source = useRead(
    (signal) => api.config({ action: "read", project }, signal),
    `config-source:${project}`,
  );
  const validated = useRead(
    (signal) => api.command({ action: "config", project }, signal),
    `config:${project}`,
  );
  const change = useAct<ConfigChange>();
  const [tree, setTree] = useState<Tree>({});
  const [section, setSection] = useState<Section>("project");
  const [reviewing, setReviewing] = useState(false);
  const [rebased, setRebased] = useState(false);
  const original = source.data?.config;
  // A fresh read replaces the draft, so a reload after apply shows what rigd wrote; after a
  // revision conflict the outstanding edits are replayed onto the newer file instead.
  const pendingEdits = useRef<ConfigPatch[] | undefined>(undefined);
  useEffect(() => {
    if (isTree(original))
      setTree(applyPatch(original, pendingEdits.current ?? []));
    pendingEdits.current = undefined;
  }, [original]);
  const patch = useMemo(
    () => (isTree(original) ? configPatch(original, tree) : []),
    [original, tree],
  );
  const draft = useMemo<Draft>(
    () => ({
      tree,
      fields: source.data?.fields ?? [],
      set: (path, value) => setTree((current) => setAt(current, path, value)),
      remove: (path) => setTree((current) => removeAt(current, path)),
    }),
    [tree, source.data?.fields],
  );
  const send = (action: "preview" | "apply") => {
    if (!source.data) return;
    const expectedRevision = source.data.revision;
    void change
      .run(() => api.config({ action, project, expectedRevision, patch }))
      .then((result) => {
        if (action === "preview" && result) setReviewing(true);
        if (result?.applied) {
          setRebased(false);
          setReviewing(false);
          source.reload();
          validated.reload();
        }
      });
  };
  // rig.yaml changed under the draft: read it again without dropping the edits.
  const conflicted =
    change.error instanceof RigdError &&
    change.error.code.toUpperCase() === "REVISION_CONFLICT";
  const { clear: clearChange } = change;
  const { reload: reloadSource } = source;
  useEffect(() => {
    if (!conflicted) return;
    pendingEdits.current = patch;
    setRebased(true);
    setReviewing(false);
    clearChange();
    reloadSource();
  }, [conflicted, patch, clearChange, reloadSource]);
  const discard = () => {
    if (isTree(original)) setTree(original);
    setRebased(false);
    change.clear();
  };
  return (
    <DraftContext.Provider value={draft}>
      <Panel
        title="Configuration"
        description={
          source.data ? (
            <Mono>
              {source.data.configPath}, revision{" "}
              {source.data.revision.slice(0, 12)}
            </Mono>
          ) : (
            "Reading rig.yaml…"
          )
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
              onClick={() => send("preview")}
            >
              {change.busy ? "Checking…" : `Review ${patch.length || ""}`}
              {patch.length === 1 ? " change" : " changes"}
            </Button>
          </>
        }
      >
        <Failure error={source.error} />
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
        {reviewing ? null : <Failure error={change.error} />}
        {source.data ? (
          <>
            <Tabs
              value={section}
              onValueChange={(next) => setSection(next as Section)}
            >
              <div className="-mx-5 overflow-x-auto px-5">
                <TabsList variant="line" className="w-max">
                  {SECTIONS.map(([value, label]) => (
                    <TabsTrigger key={value} value={value}>
                      {label}
                      {changedIn(patch, value) ? (
                        <span className="size-1.5 rounded-full bg-primary">
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
          </>
        ) : null}
      </Panel>
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
          rig.yaml as written
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 flex flex-col gap-2">
          <Source text={source.data?.raw ?? ""} />
          {validated.data ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                As rigd resolves it
              </summary>
              <Source text={JSON.stringify(validated.data.config, null, 2)} />
            </details>
          ) : null}
          <Failure error={validated.error} />
        </CollapsibleContent>
      </Collapsible>
      <Dialog
        open={reviewing}
        onOpenChange={(open) => {
          setReviewing(open);
          if (!open) change.clear();
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
            <Failure error={change.error} />
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
              onClick={() => send("apply")}
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
    "supervisor",
    "build",
    "build_timeout",
  ],
  environment: ["env", "env_file"],
  services: ["services"],
  tools: ["tools"],
  proxy: ["proxy"],
  targets: ["targets"],
};
const changedIn = (patch: { path: string[] }[], section: Section) =>
  patch.some((edit) => SECTION_ROOTS[section].includes(edit.path[0] ?? ""));
function Source({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-sidebar p-3 font-mono text-xs leading-5 whitespace-pre text-sidebar-foreground">
      {text}
    </pre>
  );
}

/* Bound controls: each reads and writes one path of the draft and shows the schema's help for it. */

function useHelp(path: string[]): string | undefined {
  const { fields } = useDraft();
  return fieldFor(fields, path)?.description;
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
    <Field label={label} htmlFor={id} help={help ?? schemaHelp}>
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
function Choice({
  path,
  label,
  options,
  unsetLabel,
}: {
  path: string[];
  label: string;
  options: readonly (readonly [string, string])[];
  unsetLabel: string;
}) {
  const draft = useDraft();
  const value = getAt(draft.tree, path);
  const id = path.join(".");
  return (
    <Field label={label} htmlFor={id} help={useHelp(path)}>
      <Select
        value={typeof value === "string" ? value : UNSET}
        onValueChange={(next) =>
          next === UNSET ? draft.remove(path) : draft.set(path, next)
        }
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>{unsetLabel}</SelectItem>
          {options.map(([option, text]) => (
            <SelectItem key={option} value={option}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
    <Field label={label} htmlFor={id} help={useHelp(path)}>
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
        help="Renaming happens under Settings so registration, routes and the Git remote stay coherent."
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
      <Choice
        path={["supervisor"]}
        label="Supervisor"
        unsetLabel="rigd (default)"
        options={[
          ["rigd", "rigd"],
          ["launchd", "launchd"],
        ]}
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
        path={[...path, "env"]}
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
        path={[...path, "run"]}
        label="Run command"
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
        <Text path={[...path, "ready"]} label="Readiness check" mono />
        <Text
          path={[...path, "ready_timeout"]}
          label="Readiness timeout"
          placeholder="30s"
          mono
        />
        <ListText path={[...path, "depends_on"]} label="Depends on" />
        <Choice
          path={[...path, "restart"]}
          label="Restart"
          unsetLabel="always (default)"
          options={[
            ["always", "always"],
            ["on-failure", "on-failure"],
            ["no", "no"],
          ]}
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
      <EnvironmentSection path={path} />
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
    initial: { run: "" },
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
    <div className="flex flex-col gap-4 rounded-md border p-4">
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
  const first = isTree(services) ? Object.keys(services)[0] : undefined;
  const ports = first ? getAt(services, [first, "ports"]) : undefined;
  const port = isTree(ports) ? Object.keys(ports)[0] : undefined;
  return (
    <div className="max-w-xl">
      <Records
        path={path}
        label="Path prefixes"
        keyLabel="prefix"
        keyPattern={PROXY_PREFIX}
        keyPlaceholder="/api"
        valueKind="text"
        valuePlaceholder="${services.web.ports.http}"
        initial={first && port ? `\${services.${first}.ports.${port}}` : ""}
      />
    </div>
  );
}
const ROLES = [
  ["working", "Working copy", "local"],
  ["stable", "Stable", "live"],
  ["preview", "Previews", undefined],
] as const;
function TargetsSection() {
  const draft = useDraft();
  const [role, setRole] = useState<(typeof ROLES)[number][0]>("working");
  const path = ["targets", role];
  const services = Object.keys(getAt(draft.tree, ["services"]) ?? {});
  const tools = Object.keys(getAt(draft.tree, ["tools"]) ?? {});
  const defaultName = ROLES.find(([r]) => r === role)?.[2];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Each role patches the Project settings for its Targets: maps merge per
        key, lists and scalars replace.
      </p>
      <Tabs value={role} onValueChange={(next) => setRole(next as typeof role)}>
        <TabsList>
          {ROLES.map(([value, label]) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div key={role} className="grid max-w-xl gap-4">
        {defaultName ? (
          <Text
            path={[...path, "name"]}
            label="Target name"
            placeholder={defaultName}
            mono
          />
        ) : null}
        <Text
          path={[...path, "domain"]}
          label="Domain"
          placeholder={
            role === "preview" ? "${rig.target}.preview.app.test" : undefined
          }
        />
        <Choice
          path={[...path, "supervisor"]}
          label="Supervisor"
          unsetLabel="As the Project"
          options={[
            ["rigd", "rigd"],
            ["launchd", "launchd"],
          ]}
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
