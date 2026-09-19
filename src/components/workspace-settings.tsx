import { MilkdownProvider } from "@milkdown/react";
import {
  ArrowLeft,
  Cable,
  Code2,
  Download,
  Files,
  FolderCog,
  ImagePlus,
  LayoutTemplate,
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
import type { ConnectorDefinition } from "../lib/connectors.ts";
import { AccessPanel } from "./auth-panels.tsx";
import { DeveloperSettings } from "./developer-panel.tsx";
import { ConnectorSettings } from "./source-panels.tsx";
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

const variablePattern = /\{\{([a-z][a-z0-9_]*)\}\}/gi;

function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="settings-section-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
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

function TemplateBuilder({
  open,
  busy,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  const [view, setView] = useState<"write" | "preview">("write");
  useEffect(() => {
    if (!open) return;
    setBody("");
    setView("write");
  }, [open]);
  const variables = useMemo(
    () =>
      Array.from(
        new Set(
          Array.from(body.matchAll(variablePattern), (match) => match[1]),
        ),
      ),
    [body],
  );
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    if (await onCreate(event)) onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="template-builder-dialog sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Create template</DialogTitle>
          <DialogDescription>
            Build a reusable document, then add variables only where readers
            need to supply context.
          </DialogDescription>
        </DialogHeader>
        <form
          className="template-builder"
          onSubmit={(event) => void submit(event)}
        >
          <div className="template-builder-meta">
            <Label>
              <span>Name</span>
              <Input
                name="name"
                maxLength={80}
                placeholder="Incident review"
                required
              />
            </Label>
            <Label>
              <span>Description</span>
              <Input
                name="description"
                maxLength={240}
                placeholder="When the team should use this template"
              />
            </Label>
          </div>
          <input type="hidden" name="body" value={body} />
          <Tabs
            value={view}
            onValueChange={(value) => setView(value as typeof view)}
          >
            <TabsList>
              <TabsTrigger value="write">Write</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="template-workbench">
            <div className="template-editor-surface">
              {view === "write"
                ? (
                  <MilkdownProvider>
                    <LocalMarkdownEditor value={body} onChange={setBody} />
                  </MilkdownProvider>
                )
                : body
                ? (
                  <MilkdownProvider key={body}>
                    <DocumentPreview markdown={body} hidePageTitle={false} />
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
                    <Badge key={variable} variant="secondary">{variable}</Badge>
                  ))
                  : <span>No variables yet</span>}
              </div>
            </aside>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !body.trim()}>
              {busy ? "Creating…" : "Create template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function NewDocumentDialog({
  open,
  spaces,
  concepts,
  templates,
  initialSpaceId,
  initialParentId,
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
  busy: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
}) {
  const [templateId, setTemplateId] = useState("");
  const [documentType, setDocumentType] = useState("Policy");
  const [intent, setIntent] = useState("canonical");
  const [spaceId, setSpaceId] = useState(initialSpaceId || spaces[0]?.id || "");
  const [parentId, setParentId] = useState(initialParentId ?? "");
  useEffect(() => {
    if (!open) return;
    setTemplateId("");
    setDocumentType("Policy");
    setIntent("canonical");
    setSpaceId(initialSpaceId || spaces[0]?.id || "");
    setParentId(initialParentId ?? "");
  }, [open, initialSpaceId, initialParentId, spaces]);
  const selectedTemplate = templates.find((item) => item.id === templateId);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    if (await onCreate(event)) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="new-document-dialog sm:max-w-2xl">
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
          onSubmit={(event) => void submit(event)}
        >
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
                <SelectItem value="canonical">Maintained knowledge</SelectItem>
                <SelectItem value="working">Working document</SelectItem>
                <SelectItem value="evidence">Evidence</SelectItem>
                <SelectItem value="ephemeral">Ephemeral notes</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          <Label>
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
          <Label className="new-document-template">
            <span>
              Template <small>optional</small>
            </span>
            <input type="hidden" name="templateId" value={templateId} />
            <Select
              value={templateId || "__blank__"}
              onValueChange={(value) => {
                const nextTemplateId = value === "__blank__" ? "" : value ?? "";
                setTemplateId(nextTemplateId);
                if (nextTemplateId === "understanding-brief") {
                  setDocumentType("Explanation");
                  setIntent("working");
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
              <Input name={`variable:${variable}`} required />
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
          {error && (
            <p className="source-error new-document-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter className="new-document-actions">
            <Button
              type="button"
              variant="outline"
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
  invitations,
  members,
  groups,
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
  invitations: Invitation[];
  members: NonNullable<Bootstrap["members"]>;
  groups: NonNullable<Bootstrap["groups"]>;
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
        <div>
          <p className="eyebrow">{workspace.name}</p>
          <h1 id="settings-heading">Workspace settings</h1>
          <p>
            Manage workspace identity, structure, members, and developer access.
          </p>
        </div>
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
                eyebrow="Workspace"
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
                    original App files.
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
                      nested document, and App folder hierarchy.
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
                      Source-owned imports and private App data stay with their
                      original systems and users.
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
                eyebrow="Ask OKF"
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
                    <strong>Provider and model</strong>
                    <code>OKF_AI_PROVIDER · OKF_AI_MODEL · OKF_AI_URL</code>
                  </div>
                  <div className="grid gap-1">
                    <strong>Ollama credential</strong>
                    <code>OLLAMA_API_KEY</code>
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
            <div className="settings-section">
              <SectionHeading
                eyebrow="Templates"
                title="Template library"
                description="Start with the built-in understanding brief or add a workspace pattern."
                action={
                  <Button
                    type="button"
                    onClick={() => setTemplateBuilderOpen(true)}
                  >
                    <Plus /> New template
                  </Button>
                }
              />
              <Card>
                <CardHeader>
                  <CardTitle>Workspace templates</CardTitle>
                  <CardDescription>
                    Templates stay editable and portable as Markdown.
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
                                    <Badge variant="secondary">Built-in</Badge>
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
                          onClick={() => setTemplateBuilderOpen(true)}
                        >
                          Create template
                        </Button>
                      </div>
                    )}
                </CardContent>
              </Card>
            </div>
          </SettingsPanel>

          <SettingsPanel value="spaces" active={section}>
            <div className="settings-section">
              <SectionHeading
                eyebrow="Structure"
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
            </div>
          </SettingsPanel>

          {canManageMembers && (
            <SettingsPanel value="members" active={section}>
              <AccessPanel
                invitations={invitations}
                members={members}
                groups={groups}
              />
            </SettingsPanel>
          )}

          {canManageConnectors && (
            <SettingsPanel value="connectors" active={section}>
              <div className="settings-section">
                <SectionHeading
                  eyebrow="Connected knowledge"
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
      {error && (
        <p className="source-error settings-error" role="alert">{error}</p>
      )}
      <TemplateBuilder
        open={templateBuilderOpen}
        busy={busy}
        onOpenChange={setTemplateBuilderOpen}
        onCreate={onCreateTemplate}
      />
    </section>
  );
}
