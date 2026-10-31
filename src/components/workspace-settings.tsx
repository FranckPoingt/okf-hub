import { MilkdownProvider } from "@milkdown/react";
import {
  ArrowLeft,
  Cable,
  Code2,
  Copy,
  Download,
  Files,
  FolderCog,
  ImagePlus,
  LayoutTemplate,
  Pencil,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AIConfig,
  Bootstrap,
  DocumentTemplate,
  Invitation,
  NotionSource,
  RepositorySource,
  SharedSource,
  Space,
} from "../lib/models.ts";
import { SERVICE } from "../lib/api.ts";
import { MarkdownWritingHelp } from "./editor/markdown-writing-help.tsx";
import { renderTemplate, templateVariables } from "../lib/templates.ts";
import type { ConnectorDefinition } from "../lib/connectors.ts";
import { AccessPanel } from "./auth-panels.tsx";
import { DeveloperSettings } from "./developer-panel.tsx";
import { ConnectorSettings } from "./source-panels.tsx";
import { SpaceManagers } from "./space-managers.tsx";
import { SpaceIconPicker } from "./space-icon-picker.tsx";
import {
  DocumentPreview,
  LocalMarkdownEditor,
} from "./editor/document-editor.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button, buttonVariants } from "./ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table.tsx";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import type { SettingsSection } from "../routes.ts";

function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="settings-section-heading">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function SettingsNavButton({
  value,
  active,
  onSelect,
  children,
}: {
  value: SettingsSection;
  active: SettingsSection;
  onSelect: (value: SettingsSection) => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={active === value ? "secondary" : "ghost"}
      className="justify-start"
      aria-current={active === value ? "page" : undefined}
      onClick={() => onSelect(value)}
    >
      {children}
    </Button>
  );
}

function SettingsPanel({
  value,
  active,
  children,
}: {
  value: SettingsSection;
  active: SettingsSection;
  children: ReactNode;
}) {
  return (
    <div
      className="settings-content-panel"
      hidden={active !== value}
    >
      {children}
    </div>
  );
}

function templateDownload(name: string, body: string) {
  const filename = name.toLocaleLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "template";
  return {
    href: `data:text/markdown;charset=utf-8,${encodeURIComponent(body)}`,
    download: `${filename}.md`,
  };
}

export type TemplateDraft = {
  name: string;
  description: string;
  body: string;
  samples: Record<string, string>;
};

export type TemplateDraftCache = Map<string, TemplateDraft>;

type TemplateBuilderMode = "new" | "edit" | "duplicate";

function TemplateBuilder({
  open,
  busy,
  error,
  template,
  mode,
  draftCache,
  onOpenChange,
  onCreate,
  onUpdate,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  template?: DocumentTemplate;
  mode: TemplateBuilderMode;
  draftCache?: TemplateDraftCache;
  onOpenChange: (open: boolean) => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
  onUpdate: (id: string, event: FormEvent<HTMLFormElement>) => Promise<boolean>;
}) {
  // The app may retain this cache for the authenticated session across settings
  // navigation. The fallback keeps unfinished work while settings stays mounted.
  const [localDraftCache] = useState<TemplateDraftCache>(() => new Map());
  const drafts = draftCache ?? localDraftCache;
  const [, rerenderDraft] = useState(0);
  const [view, setView] = useState<"write" | "preview">("write");
  const [submitted, setSubmitted] = useState(false);
  const [localError, setLocalError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const editorSnapshot = useRef<(() => string | null) | null>(null);
  const bodyField = useRef<HTMLInputElement>(null);
  const draftKey = mode === "new" ? "new" : `${mode}:${template?.id}`;
  const initialDraft: TemplateDraft = {
    name: mode === "duplicate"
      ? `${(template?.name ?? "Template").slice(0, 75).trimEnd()} copy`
      : template?.name ?? "",
    description: template?.description ?? "",
    body: template?.body ?? "",
    samples: {},
  };
  const draft = drafts.get(draftKey) ?? initialDraft;
  const changeDraft = (patch: Partial<TemplateDraft>) => {
    drafts.set(draftKey, {
      ...(drafts.get(draftKey) ?? initialDraft),
      ...patch,
    });
    rerenderDraft((value) => value + 1);
  };
  const captureBody = () => {
    const body = editorSnapshot.current?.() ?? drafts.get(draftKey)?.body ??
      draft.body;
    if (body !== draft.body) changeDraft({ body });
    return body;
  };
  const backToLibrary = () => {
    captureBody();
    onOpenChange(false);
  };
  useEffect(() => {
    if (!open) return;
    setSubmitted(false);
    setLocalError("");
    heading.current?.focus();
  }, [open, draftKey]);
  const variables = useMemo(() => templateVariables(draft.body), [draft.body]);
  const sampleValue = (name: string) =>
    Object.hasOwn(draft.samples, name) ? draft.samples[name] : "";
  const preview = renderTemplate(
    draft.body,
    Object.fromEntries(variables.map((name) => [
      name,
      sampleValue(name).trim() ? sampleValue(name) : `{{${name}}}`,
    ])),
  );
  const previewMarkdown = "body" in preview ? preview.body : draft.body;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    setLocalError("");
    try {
      // Root creates FormData synchronously; update the hidden field before it
      // reads the form, including edits not yet reflected in React's render.
      const body = captureBody();
      if (bodyField.current) bodyField.current.value = body;
      const saved = mode === "edit" && template
        ? await onUpdate(template.id, event)
        : await onCreate(event);
      if (!saved) return;
      drafts.delete(draftKey);
      rerenderDraft((value) => value + 1);
      setView("write");
      onOpenChange(false);
    } catch {
      setLocalError(
        "Could not save the template. Your work is still here; try again.",
      );
    }
  };
  const builderError = localError || (submitted ? error : "");
  return (
    <div hidden={!open}>
      <section
        className="settings-section"
        aria-labelledby="template-workbench-heading"
      >
        <header className="grid gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-fit"
            disabled={busy}
            onClick={backToLibrary}
          >
            <ArrowLeft /> Back to templates
          </Button>
          <h2
            id="template-workbench-heading"
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-semibold"
          >
            {mode === "edit"
              ? "Edit template"
              : mode === "duplicate"
              ? "Duplicate template"
              : "Create template"}
          </h2>
          <p className="text-sm text-muted-foreground">
            Build a reusable document, then add variables only where readers
            need to supply context. {draftCache
              ? "Unfinished work stays here while you navigate. Save your template before reloading."
              : "Unfinished work stays here until you leave workspace settings."}
          </p>
        </header>
        <form
          className="template-builder"
          aria-busy={busy}
          onSubmit={(event) => void submit(event)}
        >
          <div className="template-builder-meta">
            <Label>
              <span>Name</span>
              <Input
                name="name"
                disabled={busy}
                maxLength={80}
                placeholder="Incident review"
                value={draft.name}
                onChange={(event) => changeDraft({ name: event.target.value })}
                required
              />
            </Label>
            <Label>
              <span>Description</span>
              <Input
                name="description"
                disabled={busy}
                maxLength={240}
                placeholder="When the team should use this template"
                value={draft.description}
                onChange={(event) =>
                  changeDraft({ description: event.target.value })}
              />
            </Label>
          </div>
          <input ref={bodyField} type="hidden" name="body" value={draft.body} />
          <Tabs
            value={view}
            onValueChange={(value) => {
              captureBody();
              setView(value as typeof view);
            }}
          >
            <TabsList>
              <TabsTrigger value="write" disabled={busy}>Write</TabsTrigger>
              <TabsTrigger value="preview" disabled={busy}>Preview</TabsTrigger>
            </TabsList>
          </Tabs>
          {view === "write" && <MarkdownWritingHelp />}
          <div className="template-workbench">
            <div className="template-editor-surface" inert={busy}>
              {open && view === "write"
                ? (
                  <MilkdownProvider key={draftKey}>
                    <LocalMarkdownEditor
                      value={draft.body}
                      onChange={(body) => changeDraft({ body })}
                      onSnapshotReady={(read) => {
                        editorSnapshot.current = read;
                      }}
                    />
                  </MilkdownProvider>
                )
                : open && draft.body
                ? (
                  <MilkdownProvider key={previewMarkdown}>
                    <DocumentPreview
                      markdown={previewMarkdown}
                      hidePageTitle={false}
                    />
                  </MilkdownProvider>
                )
                : (
                  <p className="template-preview-empty">
                    Add content to preview the template.
                  </p>
                )}
            </div>
            <aside className="template-variable-guide">
              <h3>Variables</h3>
              <p>Type a variable anywhere using double braces, for example:</p>
              <code>{"{{team}}"}</code>
              <code>{"{{owner}}"}</code>
              <div className="template-detected-variables">
                <strong>Detected</strong>
                {variables.length
                  ? variables.map((variable) => (
                    <Label key={variable} className="grid w-full gap-2">
                      <Badge variant="secondary">{variable}</Badge>
                      <Input
                        aria-label={`Sample ${variable}`}
                        disabled={busy}
                        placeholder="Sample value"
                        value={sampleValue(variable)}
                        onChange={(event) =>
                          changeDraft({
                            samples: {
                              ...draft.samples,
                              [variable]: event.target.value,
                            },
                          })}
                      />
                    </Label>
                  ))
                  : <span>No variables yet</span>}
              </div>
              {variables.length > 0 && (
                <p>
                  Sample values appear in Preview only. Blank samples keep the
                  placeholders.
                </p>
              )}
            </aside>
          </div>
          {builderError && (
            <p className="source-error" role="alert">{builderError}</p>
          )}
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
            {draft.body.trim() && (
              <Button
                variant="outline"
                render={
                  <a
                    {...templateDownload(draft.name, draft.body)}
                    onClick={(event) => {
                      event.currentTarget.href =
                        templateDownload(draft.name, captureBody()).href;
                    }}
                  />
                }
              >
                <Download /> Download Markdown
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={backToLibrary}
            >
              Back to templates
            </Button>
            <Button type="submit" disabled={busy || !draft.body.trim()}>
              {busy
                ? "Saving…"
                : mode === "edit"
                ? "Save template"
                : "Create template"}
            </Button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function NewDocumentDialog({
  open,
  spaces,
  concepts,
  templates,
  initialSpaceId,
  initialParentId,
  initialTemplateId,
  initialType = "Document",
  initialIntent = "canonical",
  busy,
  error,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  spaces: Space[];
  concepts: { id: string; spaceId: string; title: string; status: string }[];
  templates: DocumentTemplate[];
  initialSpaceId?: string;
  initialParentId?: string;
  initialTemplateId?: string;
  initialType?: string;
  initialIntent?: string;
  busy: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
}) {
  const brief = initialTemplateId === "understanding-brief";
  const [templateId, setTemplateId] = useState(initialTemplateId ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [documentType, setDocumentType] = useState(
    brief ? "Explanation" : initialType,
  );
  const [intent, setIntent] = useState(brief ? "working" : initialIntent);
  const [spaceId, setSpaceId] = useState(initialSpaceId || spaces[0]?.id || "");
  const [parentId, setParentId] = useState(initialParentId ?? "");
  useEffect(() => {
    if (!open) return;
    setTemplateId(initialTemplateId ?? "");
    setValues({});
    setDocumentType(brief ? "Explanation" : initialType);
    setIntent(brief ? "working" : initialIntent);
    setSpaceId(initialSpaceId || spaces[0]?.id || "");
    setParentId(initialParentId ?? "");
  }, [
    open,
    brief,
    initialIntent,
    initialParentId,
    initialSpaceId,
    initialTemplateId,
    initialType,
    spaces,
  ]);
  const selectedTemplate = templates.find((item) => item.id === templateId);
  const variableValue = (name: string) =>
    Object.hasOwn(values, name) ? values[name] : "";
  const filledPreview = selectedTemplate
    ? renderTemplate(
      selectedTemplate.body,
      Object.fromEntries(
        selectedTemplate.variables.map((
          name,
        ) => [
          name,
          variableValue(name).trim() ? variableValue(name) : `{{${name}}}`,
        ]),
      ),
    )
    : null;
  const previewMarkdown = filledPreview && "body" in filledPreview
    ? filledPreview.body
    : "";
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    if (await onCreate(event)) onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="new-document-dialog max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New document</DialogTitle>
          <DialogDescription>
            Start blank or apply a workspace template. Access comes from the
            selected space.
          </DialogDescription>
        </DialogHeader>
        <form
          key={`${initialSpaceId ?? "default"}-${open}`}
          className="new-document-form"
          aria-busy={busy}
          onSubmit={(event) => void submit(event)}
        >
          <div className="contents" inert={busy}>
            <Label className="new-document-title">
              <span>Title</span>
              <Input
                name="title"
                maxLength={100}
                placeholder="Untitled document"
                required
                autoFocus
              />
            </Label>
            <Label className="col-span-full">
              <span>Space</span>
              <Select
                name="spaceId"
                value={spaceId}
                onValueChange={(value) => {
                  const nextSpaceId = value ?? "";
                  setSpaceId(nextSpaceId);
                  if (
                    parentId &&
                    concepts.find((item) => item.id === parentId)?.spaceId !==
                      nextSpaceId
                  ) setParentId("");
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {spaces.find((space) => space.id === spaceId)?.name ||
                      "Choose a space"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {spaces.map((space) => (
                    <SelectItem key={space.id} value={space.id}>
                      {space.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
            <Label className="new-document-template">
              <span>
                Template <small>optional</small>
              </span>
              <input type="hidden" name="templateId" value={templateId} />
              <Select
                value={templateId || "__blank__"}
                onValueChange={(value) => {
                  const nextTemplateId = value === "__blank__"
                    ? ""
                    : value ?? "";
                  setTemplateId(nextTemplateId);
                  setValues({});
                  if (nextTemplateId === "understanding-brief") {
                    setDocumentType("Explanation");
                    setIntent("working");
                  } else if (templateId === "understanding-brief") {
                    setDocumentType("Document");
                    setIntent("canonical");
                  }
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {selectedTemplate?.name || "Blank document"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__blank__">Blank document</SelectItem>
                  {templates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
            {selectedTemplate?.variables.map((variable) => (
              <Label key={variable}>
                <span>{variable.replaceAll("_", " ")}</span>
                <Input
                  name={`variable:${variable}`}
                  value={variableValue(variable)}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [variable]: event.target.value,
                    }))}
                  required
                />
              </Label>
            ))}
            {selectedTemplate && (
              <div className="new-document-template-summary">
                <LayoutTemplate />
                <div>
                  <strong>{selectedTemplate.name}</strong>
                  <span>
                    {selectedTemplate.description ||
                      "Reusable workspace template"}
                  </span>
                </div>
              </div>
            )}
            {selectedTemplate && previewMarkdown && (
              <details className="col-span-full rounded-lg border p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Preview document
                </summary>
                <p className="mt-2 text-xs text-muted-foreground">
                  Your values appear below. Unfilled variables keep their
                  placeholders.
                </p>
                <div className="mt-3 max-h-72 overflow-auto">
                  <MilkdownProvider key={previewMarkdown}>
                    <DocumentPreview
                      markdown={previewMarkdown}
                      hidePageTitle={false}
                    />
                  </MilkdownProvider>
                </div>
              </details>
            )}
            <details
              className="col-span-full rounded-lg border p-3"
              onInvalidCapture={(event) => {
                event.currentTarget.open = true;
              }}
            >
              <summary className="cursor-pointer text-sm font-medium">
                Document options
              </summary>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Label>
                  <span>Type</span>
                  <Input
                    name="type"
                    maxLength={50}
                    value={documentType}
                    onChange={(event) => setDocumentType(event.target.value)}
                    required
                  />
                </Label>
                <Label>
                  <span>Intent</span>
                  <Select
                    name="intent"
                    value={intent}
                    onValueChange={(value) => setIntent(value ?? "canonical")}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        {intent === "canonical"
                          ? "Maintained knowledge"
                          : intent === "working"
                          ? "Working document"
                          : intent === "evidence"
                          ? "Evidence"
                          : "Ephemeral notes"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="canonical">
                        Maintained knowledge
                      </SelectItem>
                      <SelectItem value="working">Working document</SelectItem>
                      <SelectItem value="evidence">Evidence</SelectItem>
                      <SelectItem value="ephemeral">Ephemeral notes</SelectItem>
                    </SelectContent>
                  </Select>
                </Label>
                <Label>
                  <span>
                    Parent document <small>optional</small>
                  </span>
                  <input type="hidden" name="parentId" value={parentId} />
                  <Select
                    value={parentId || "__root__"}
                    onValueChange={(value) =>
                      setParentId(value === "__root__" ? "" : value ?? "")}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        {concepts.find((item) => item.id === parentId)?.title ||
                          "Top level"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__root__">Top level</SelectItem>
                      {concepts.filter((item) =>
                        item.spaceId === spaceId && item.status === "active"
                      ).map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Label>
              </div>
            </details>
          </div>
          {error && (
            <p className="source-error new-document-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter className="new-document-actions">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create document"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WorkspaceSettings({
  workspace,
  aiConfig,
  spaces,
  templates,
  templateDraftCache,
  invitations,
  members,
  groups,
  currentUserId,
  connectors,
  repositories,
  sharedSource,
  notionSource,
  canExportWorkspace,
  canManageMembers,
  canManageConnectors,
  connectorBusy,
  busy,
  error,
  initialSection,
  onSectionChange,
  onCreateSpace,
  onRenameSpace,
  onDeleteSpace,
  onCreateTemplate,
  onUpdateTemplate,
  onUseTemplate,
  onDeleteTemplate,
  onUpdateWorkspace,
  onConnectConnector,
  onSetConnectorEnabled,
  onConnectGitHub,
  onCancel,
}: {
  workspace: NonNullable<Bootstrap["workspace"]>;
  aiConfig: AIConfig;
  spaces: Space[];
  templates: DocumentTemplate[];
  templateDraftCache?: TemplateDraftCache;
  invitations: Invitation[];
  members: NonNullable<Bootstrap["members"]>;
  groups: NonNullable<Bootstrap["groups"]>;
  currentUserId?: string;
  connectors: ConnectorDefinition[];
  repositories: RepositorySource[];
  sharedSource: SharedSource | null;
  notionSource: NotionSource | null;
  canExportWorkspace: boolean;
  canManageMembers: boolean;
  canManageConnectors: boolean;
  connectorBusy: boolean;
  busy: boolean;
  error: string;
  initialSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onCreateSpace: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
  onRenameSpace: (
    event: FormEvent<HTMLFormElement>,
    space: Space,
  ) => Promise<void>;
  onDeleteSpace: (space: Space) => Promise<void>;
  onCreateTemplate: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
  onUpdateTemplate: (
    id: string,
    event: FormEvent<HTMLFormElement>,
  ) => Promise<boolean>;
  onUseTemplate: (templateId: string) => void;
  onDeleteTemplate: (template: DocumentTemplate) => Promise<void>;
  onUpdateWorkspace: (value: {
    name: string;
    tagline: string;
    logo: string;
  }) => Promise<boolean>;
  onConnectConnector: (
    connector: ConnectorDefinition,
    values: Record<string, string>,
  ) => Promise<void>;
  onSetConnectorEnabled: (id: string, enabled: boolean) => Promise<void>;
  onConnectGitHub: (
    installationId: number,
    repositoryId: number,
    folder: string,
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [templateBuilderOpen, setTemplateBuilderOpen] = useState(false);
  const [templateBuilderTarget, setTemplateBuilderTarget] = useState<
    { mode: TemplateBuilderMode; id?: string }
  >({ mode: "new" });
  const openTemplateBuilder = (mode: TemplateBuilderMode, id?: string) => {
    setTemplateBuilderTarget({ mode, id });
    setTemplateBuilderOpen(true);
  };
  const [logo, setLogo] = useState(workspace.logo);
  const [logoError, setLogoError] = useState("");
  const [newSpaceIcon, setNewSpaceIcon] = useState("");
  const [spaceIcons, setSpaceIcons] = useState<Record<string, string>>({});
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<"workspace" | "space">(
    canExportWorkspace ? "workspace" : "space",
  );
  const [exportSpaceId, setExportSpaceId] = useState(spaces[0]?.id ?? "");
  const exportSpace = spaces.find((space) => space.id === exportSpaceId) ??
    spaces[0];
  const exportHref = exportScope === "workspace" && canExportWorkspace
    ? `${SERVICE}/api/exports/workspace`
    : exportSpace
    ? `${SERVICE}/api/exports/spaces/${encodeURIComponent(exportSpace.id)}`
    : "";
  useEffect(() => setSection(initialSection), [initialSection]);
  useEffect(() => setLogo(workspace.logo), [workspace.logo]);
  const changeSection = (next: SettingsSection) => {
    setSection(next);
    onSectionChange(next);
  };
  const chooseLogo = (file?: File) => {
    if (!file) return;
    if (!/^image\/(?:png|jpeg|webp)$/.test(file.type) || file.size > 256_000) {
      setLogoError("Use a PNG, JPEG, or WebP logo under 256 KB.");
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      setLogo(String(reader.result ?? ""));
      setLogoError("");
    });
    reader.readAsDataURL(file);
  };

  return (
    <section className="settings-page" aria-labelledby="settings-heading">
      <header className="settings-page-header">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          <ArrowLeft /> Back
        </Button>
        {/* Breadcrumb and section heading already title the page. */}
        <h1 id="settings-heading" className="sr-only">Workspace settings</h1>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <SettingsNavButton
            value="general"
            active={section}
            onSelect={changeSection}
          >
            <Settings2 /> General
          </SettingsNavButton>
          <SettingsNavButton
            value="ai"
            active={section}
            onSelect={changeSection}
          >
            <Sparkles /> AI
          </SettingsNavButton>
          <SettingsNavButton
            value="templates"
            active={section}
            onSelect={changeSection}
          >
            <LayoutTemplate /> Templates
          </SettingsNavButton>
          <SettingsNavButton
            value="spaces"
            active={section}
            onSelect={changeSection}
          >
            <FolderCog /> Spaces
          </SettingsNavButton>
          {canManageMembers && (
            <SettingsNavButton
              value="members"
              active={section}
              onSelect={changeSection}
            >
              <Users /> Members
            </SettingsNavButton>
          )}
          {canManageConnectors && (
            <SettingsNavButton
              value="connectors"
              active={section}
              onSelect={changeSection}
            >
              <Cable /> Connectors
            </SettingsNavButton>
          )}
          <SettingsNavButton
            value="developer"
            active={section}
            onSelect={changeSection}
          >
            <Code2 /> Developer
          </SettingsNavButton>
        </nav>

        <div className="settings-content">
          <SettingsPanel value="general" active={section}>
            <div className="settings-section">
              <SectionHeading
                title="Knowledge configuration"
                description="A compact overview of the structure this workspace currently exposes."
              />
              <Card>
                <CardHeader>
                  <CardTitle>Workspace identity</CardTitle>
                  <CardDescription>
                    Shown in the sidebar and shared workspace surfaces.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form
                    className="workspace-identity-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const fields = new FormData(event.currentTarget);
                      void onUpdateWorkspace({
                        name: String(fields.get("name") ?? ""),
                        tagline: String(fields.get("tagline") ?? ""),
                        logo,
                      });
                    }}
                  >
                    <div
                      className="workspace-logo-drop"
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        chooseLogo(event.dataTransfer.files[0]);
                      }}
                    >
                      {logo
                        ? <img src={logo} alt="Workspace logo preview" />
                        : (
                          <span>
                            {workspace.name.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                      <div>
                        <strong>Logo</strong>
                        <small>Drop an image or choose a file.</small>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            document.getElementById("workspace-logo-input")
                              ?.click()}
                        >
                          <ImagePlus /> Choose logo
                        </Button>
                        {logo && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setLogo("")}
                          >
                            Remove
                          </Button>
                        )}
                        <input
                          id="workspace-logo-input"
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          hidden
                          onChange={(event) =>
                            chooseLogo(event.target.files?.[0])}
                        />
                      </div>
                    </div>
                    <Label>
                      <span>Name</span>
                      <Input
                        name="name"
                        defaultValue={workspace.name}
                        maxLength={60}
                        required
                      />
                    </Label>
                    <Label>
                      <span>Tagline</span>
                      <Input
                        name="tagline"
                        defaultValue={workspace.tagline}
                        maxLength={100}
                      />
                    </Label>
                    {logoError && (
                      <p className="source-error" role="alert">{logoError}</p>
                    )}
                    <Button type="submit" disabled={busy}>
                      Save workspace
                    </Button>
                  </form>
                </CardContent>
              </Card>
              <div className="settings-summary-grid">
                <Card>
                  <CardHeader>
                    <Files />
                    <CardTitle>
                      {spaces.reduce((total, space) => total + space.count, 0)}
                      {" "}
                      documents
                    </CardTitle>
                    <CardDescription>
                      Hub-native OKF documents across all spaces.
                    </CardDescription>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader>
                    <FolderCog />
                    <CardTitle>{spaces.length} spaces</CardTitle>
                    <CardDescription>
                      Permission and organization boundaries.
                    </CardDescription>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader>
                    <LayoutTemplate />
                    <CardTitle>{templates.length} templates</CardTitle>
                    <CardDescription>
                      Workspace-authored reusable document structures.
                    </CardDescription>
                  </CardHeader>
                </Card>
              </div>
              <Card>
                <CardHeader>
                  <CardTitle>Export your data</CardTitle>
                  <CardDescription>
                    Download a portable ZIP of your hub-native Markdown and
                    original Artifact files.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center justify-between gap-4">
                  <p className="text-xs text-muted-foreground">
                    Choose the whole workspace or a single space when you are
                    ready to export.
                  </p>
                  <Button type="button" onClick={() => setExportOpen(true)}>
                    <Download /> Export data
                  </Button>
                </CardContent>
              </Card>
              <Dialog open={exportOpen} onOpenChange={setExportOpen}>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Export data</DialogTitle>
                    <DialogDescription>
                      Choose what to include. The ZIP keeps the same space,
                      nested document, and Artifact folder hierarchy.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-2">
                    <Label>
                      <span>Scope</span>
                      <Select
                        value={exportScope}
                        onValueChange={(value) =>
                          setExportScope(
                            value === "workspace" ? "workspace" : "space",
                          )}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue>
                            {exportScope === "workspace"
                              ? "Entire workspace"
                              : "One space"}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {canExportWorkspace && (
                            <SelectItem value="workspace">
                              Entire workspace
                            </SelectItem>
                          )}
                          <SelectItem value="space">One space</SelectItem>
                        </SelectContent>
                      </Select>
                    </Label>
                    {exportScope === "space" && (
                      <Label>
                        <span>Space</span>
                        <Select
                          value={exportSpace?.id ?? ""}
                          onValueChange={(value) =>
                            setExportSpaceId(value ?? "")}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue>
                              {exportSpace?.name || "Choose a space"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {spaces.map((space) => (
                              <SelectItem key={space.id} value={space.id}>
                                {space.icon} {space.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Label>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Includes current drafts and archived documents.
                      Source-owned imports and private Artifact data stay with
                      their original systems and users.
                    </p>
                  </div>
                  <DialogFooter showCloseButton>
                    {exportHref && (
                      <a
                        href={exportHref}
                        download
                        onClick={() => setExportOpen(false)}
                        className={buttonVariants()}
                      >
                        <Download /> Download ZIP
                      </a>
                    )}
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </SettingsPanel>

          <SettingsPanel value="ai" active={section}>
            <div className="settings-section">
              <SectionHeading
                title="AI provider"
                description="The provider runs on the OKF server. API keys are never sent to the browser."
              />
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle>Server configuration</CardTitle>
                    <Badge variant={aiConfig.enabled ? "default" : "secondary"}>
                      {aiConfig.enabled ? "Ready" : "Not configured"}
                    </Badge>
                  </div>
                  <CardDescription>
                    {aiConfig.enabled
                      ? `${aiConfig.provider} · ${aiConfig.model}`
                      : "Set the provider and model in the server environment."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm">
                  <div className="grid gap-1">
                    <strong>Provider, model, and endpoint</strong>
                    <code>OKF_AI_PROVIDER · OKF_AI_MODEL · OKF_AI_URL</code>
                  </div>
                  <div className="grid gap-1">
                    <strong>Provider credential</strong>
                    <code>OKF_AI_API_KEY</code>
                    <span className="text-xs text-muted-foreground">
                      Keep this secret in the deployment environment or local
                      ignored env file.
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </SettingsPanel>

          <SettingsPanel value="templates" active={section}>
            <div hidden={templateBuilderOpen}>
              <div className="settings-section">
                <SectionHeading
                  title="Template library"
                  description="Start with the built-in understanding brief or add a workspace pattern."
                  action={
                    <Button
                      type="button"
                      onClick={() => openTemplateBuilder("new")}
                    >
                      <Plus /> New template
                    </Button>
                  }
                />
                <Card>
                  <CardHeader>
                    <CardTitle>Workspace templates</CardTitle>
                    <CardDescription>
                      Save a document as a template from its menu. Edit patterns
                      here; changes apply to new documents.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {templates.length
                      ? (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Template</TableHead>
                              <TableHead>Variables</TableHead>
                              <TableHead>Updated</TableHead>
                              <TableHead>
                                <span className="sr-only">Actions</span>
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {templates.map((template) => (
                              <TableRow key={template.id}>
                                <TableCell>
                                  <div className="flex items-center gap-2">
                                    <strong>{template.name}</strong>
                                    {template.builtIn && (
                                      <Badge variant="secondary">
                                        Built-in
                                      </Badge>
                                    )}
                                  </div>
                                  <small className="template-table-description">
                                    {template.description || "No description"}
                                  </small>
                                </TableCell>
                                <TableCell>
                                  {template.variables.length
                                    ? template.variables.map((variable) => (
                                      <Badge key={variable} variant="secondary">
                                        {variable}
                                      </Badge>
                                    ))
                                    : (
                                      <span className="text-muted-foreground">
                                        None
                                      </span>
                                    )}
                                </TableCell>
                                <TableCell>
                                  {new Date(template.updatedAt)
                                    .toLocaleDateString()}
                                </TableCell>
                                <TableCell className="text-right">
                                  <div className="flex items-center justify-end gap-1">
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      disabled={busy}
                                      onClick={() =>
                                        onUseTemplate(template.id)}
                                    >
                                      Use
                                    </Button>
                                    {!template.builtIn && (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        disabled={busy}
                                        aria-label={`Edit ${template.name}`}
                                        title="Edit template"
                                        onClick={() =>
                                          openTemplateBuilder(
                                            "edit",
                                            template.id,
                                          )}
                                      >
                                        <Pencil />
                                      </Button>
                                    )}
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-sm"
                                      disabled={busy}
                                      aria-label={`Duplicate ${template.name}`}
                                      title="Duplicate template"
                                      onClick={() =>
                                        openTemplateBuilder(
                                          "duplicate",
                                          template.id,
                                        )}
                                    >
                                      <Copy />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      aria-label={`Download ${template.name} Markdown`}
                                      title="Download Markdown"
                                      render={
                                        <a
                                          {...templateDownload(
                                            template.name,
                                            template.body,
                                          )}
                                        />
                                      }
                                    >
                                      <Download />
                                    </Button>
                                    {!template.builtIn && (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={`Delete ${template.name}`}
                                        disabled={busy}
                                        onClick={() =>
                                          void onDeleteTemplate(template)}
                                      >
                                        <Trash2 />
                                      </Button>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )
                      : (
                        <div className="settings-empty-state">
                          <LayoutTemplate />
                          <h3>No templates yet</h3>
                          <p>
                            Create a reusable structure when a real document
                            pattern emerges.
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => openTemplateBuilder("new")}
                          >
                            Create template
                          </Button>
                        </div>
                      )}
                  </CardContent>
                </Card>
              </div>
            </div>
            <TemplateBuilder
              open={templateBuilderOpen}
              busy={busy}
              error={error}
              mode={templateBuilderTarget.mode}
              draftCache={templateDraftCache}
              template={templates.find((item) =>
                item.id === templateBuilderTarget.id
              )}
              onOpenChange={setTemplateBuilderOpen}
              onCreate={onCreateTemplate}
              onUpdate={onUpdateTemplate}
            />
          </SettingsPanel>

          <SettingsPanel value="spaces" active={section}>
            <div className="settings-section">
              <SectionHeading
                title="Spaces"
                description="Spaces organize documents and provide their default access boundary."
              />
              <Card>
                <CardHeader>
                  <CardTitle>Create space</CardTitle>
                  <CardDescription>
                    Add a space only when content needs a distinct home or
                    permission boundary.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form
                    className="create-space-form"
                    onSubmit={(event) =>
                      void onCreateSpace(event).then((created) => {
                        if (created) setNewSpaceIcon("");
                      })}
                  >
                    <div className="grid gap-2">
                      <span className="text-sm font-medium">Icon or emoji</span>
                      <input
                        type="hidden"
                        name="icon"
                        value={newSpaceIcon}
                        readOnly
                      />
                      <SpaceIconPicker
                        value={newSpaceIcon}
                        label="Choose space icon or emoji"
                        onChange={setNewSpaceIcon}
                      />
                    </div>
                    <Label>
                      <span>Name</span>
                      <Input
                        name="name"
                        maxLength={60}
                        placeholder="People operations"
                        required
                      />
                    </Label>
                    <Button type="submit" disabled={busy}>
                      <Plus /> Create space
                    </Button>
                  </form>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Manage spaces</CardTitle>
                  <CardDescription>
                    Rename a space without changing its document URLs.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-settings-list">
                  {spaces.map((space) => (
                    <form
                      key={space.id}
                      onSubmit={(event) => void onRenameSpace(event, space)}
                    >
                      <div>
                        <input
                          type="hidden"
                          name="icon"
                          value={spaceIcons[space.id] ?? space.icon}
                          readOnly
                        />
                        <SpaceIconPicker
                          value={spaceIcons[space.id] ?? space.icon}
                          label={`Choose ${space.name} icon or emoji`}
                          onChange={(icon) =>
                            setSpaceIcons((current) => ({
                              ...current,
                              [space.id]: icon,
                            }))}
                        />
                      </div>
                      <Label>
                        <span className="sr-only">{space.name} name</span>
                        <Input
                          name="name"
                          maxLength={60}
                          defaultValue={space.name}
                          required
                        />
                      </Label>
                      <Badge variant="secondary">{space.count} documents</Badge>
                      <Button type="submit" variant="outline" disabled={busy}>
                        Save
                      </Button>
                      {space.id !== "policies" && (
                        <Button
                          type="button"
                          variant="destructive"
                          size="icon"
                          aria-label={`Delete ${space.name}`}
                          disabled={busy || space.count > 0}
                          onClick={() => void onDeleteSpace(space)}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </form>
                  ))}
                </CardContent>
              </Card>
              {canManageMembers && spaces.map((space) => (
                <Card key={space.id}>
                  <CardHeader>
                    <CardTitle>{space.name}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <SpaceManagers spaceId={space.id} members={members} />
                  </CardContent>
                </Card>
              ))}
            </div>
          </SettingsPanel>

          {canManageMembers && (
            <SettingsPanel value="members" active={section}>
              <AccessPanel
                invitations={invitations}
                members={members}
                groups={groups}
                currentUserId={currentUserId}
              />
            </SettingsPanel>
          )}

          {canManageConnectors && (
            <SettingsPanel value="connectors" active={section}>
              <div className="settings-section">
                <SectionHeading
                  title="Connector settings"
                  description="Enable providers and configure how they import knowledge or embed source links."
                />
                <ConnectorSettings
                  connectors={connectors}
                  repositories={repositories}
                  sharedSource={sharedSource}
                  notionSource={notionSource}
                  busy={connectorBusy}
                  onConnect={onConnectConnector}
                  onSetEnabled={onSetConnectorEnabled}
                  onConnectGitHub={onConnectGitHub}
                />
              </div>
            </SettingsPanel>
          )}

          <SettingsPanel value="developer" active={section}>
            <DeveloperSettings />
          </SettingsPanel>
        </div>
      </div>
      {error && (section !== "templates" || !templateBuilderOpen) && (
        <p className="source-error settings-error" role="alert">{error}</p>
      )}
    </section>
  );
}
