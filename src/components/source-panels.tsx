import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AppWindow,
  ChevronDown,
  Code2,
  Database,
  ExternalLink,
  FileText,
  FileUp,
  FolderOpen,
  GitBranch,
  HeartPulse,
  History,
  LoaderCircle,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { api, SERVICE } from "../lib/api.ts";
import type {
  Artifact,
  ArtifactState,
  AutomationState,
  ImportedConcept,
  NotionSource,
  RepositorySource,
  SharedSource,
  SourceIssue,
} from "../lib/models.ts";
import type { ConnectorDefinition } from "../lib/connectors.ts";
import { Badge } from "./ui/badge.tsx";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { Switch } from "./ui/switch.tsx";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table.tsx";

function SourceIssues({ issues }: { issues: SourceIssue[] }) {
  if (!issues.length) return null;
  return (
    <section className="source-issues" aria-label="Source issues">
      <h3>Source issues</h3>
      {issues.map((issue) => (
        <p key={`${issue.status}-${issue.path}`}>
          <strong>{issue.status}</strong>
          <code>{issue.path}</code>
          <span>
            {issue.error ?? (issue.nextPath
              ? `Moved to ${issue.nextPath}`
              : "No longer present at the source revision")}
          </span>
        </p>
      ))}
    </section>
  );
}

function ImportList(
  { sourceId, imports, onOpen }: {
    sourceId: string;
    imports: ImportedConcept[];
    onOpen: (
      sourceId: string,
      path: string,
    ) => Promise<unknown>;
  },
) {
  const sourceImports = imports.filter((item) => item.sourceId === sourceId);
  return (
    <details className="source-documents">
      <summary>
        <span>
          <FileText /> Imported documents
        </span>
        <Badge variant="secondary">{sourceImports.length}</Badge>
        <ChevronDown className="source-details-chevron" />
      </summary>
      <div className="source-document-list">
        <Table aria-label="Imported documents">
          <TableHeader>
            <TableRow>
              <TableHead>Document</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Source path</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sourceImports.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <Button
                    type="button"
                    variant="link"
                    className="source-document-link"
                    onClick={() => void onOpen(sourceId, item.path)}
                  >
                    {item.title}
                  </Button>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{item.type}</Badge>
                </TableCell>
                <TableCell className="source-document-path">
                  <code>{item.path}</code>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </details>
  );
}

type GitHubRepositoryOption = {
  id: number;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
};

const scheduleOptions = [
  [0, "Off"],
  [60, "Hourly"],
  [360, "Every 6 hours"],
  [720, "Every 12 hours"],
  [1440, "Daily"],
  [10080, "Weekly"],
] as const;

function SourceSchedule({
  sourceId,
  value,
  busy,
  canManage,
  onChange,
}: {
  sourceId: string;
  value: number;
  busy: boolean;
  canManage: boolean;
  onChange: (sourceId: string, intervalMinutes: number) => Promise<void>;
}) {
  if (!canManage) {
    return scheduleOptions.find(([minutes]) => minutes === value)?.[1] ??
      `${value} minutes`;
  }
  return (
    <Select
      value={String(value)}
      disabled={busy}
      onValueChange={(next) => void onChange(sourceId, Number(next ?? value))}
    >
      <SelectTrigger
        className="h-8 min-w-36"
        aria-label={`Automatic checks for ${sourceId}`}
      >
        <SelectValue>
          {(selected) =>
            scheduleOptions.find(([minutes]) => String(minutes) === selected)
              ?.[1] ?? selected}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {scheduleOptions.map(([minutes, label]) => (
          <SelectItem key={minutes} value={String(minutes)}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function GitHubConnectPanel({
  busy,
  onConnect,
  hasConnectedRepository = false,
}: {
  busy: boolean;
  hasConnectedRepository?: boolean;
  onConnect: (
    installationId: number,
    repositoryId: number,
    folder: string,
  ) => Promise<void>;
}) {
  const [config, setConfig] = useState<
    {
      configured: boolean;
      installUrl: string | null;
      setupUrl: string;
    } | null
  >(null);
  const [installationId] = useState(() => {
    const value = new URLSearchParams(globalThis.location.search).get(
      "github_installation",
    );
    return value ? Number(value) : Number.NaN;
  });
  const [repositories, setRepositories] = useState<GitHubRepositoryOption[]>(
    [],
  );
  const [repositoryId, setRepositoryId] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [folder, setFolder] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/sources/github").then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "GitHub unavailable");
      setConfig(result);
      if (result.configured && Number.isSafeInteger(installationId)) {
        setLoading(true);
        const repositoriesResponse = await api(
          `/api/sources/github/repositories?installationId=${installationId}`,
        );
        const repositoriesResult = await repositoriesResponse.json();
        if (!repositoriesResponse.ok) {
          throw new Error(
            repositoriesResult.error ?? "Repositories unavailable",
          );
        }
        setRepositories(repositoriesResult.repositories);
      }
    }).catch((cause) => setError(cause.message)).finally(() =>
      setLoading(false)
    );
  }, [installationId]);

  const chooseRepository = async (value: string | null) => {
    const next = value ?? "";
    setRepositoryId(next);
    setFolder("");
    setFolders([]);
    if (!next) return;
    setLoading(true);
    setError("");
    const response = await api(
      `/api/sources/github/folders?installationId=${installationId}&repositoryId=${next}`,
    );
    const result = await response.json();
    setLoading(false);
    if (!response.ok) return setError(result.error ?? "Folders unavailable");
    setFolders(result.folders);
    setFolder(result.folders.includes("okf") ? "okf" : result.folders[0] ?? "");
  };

  if (!config && !error) {
    return (
      <div className="source-github-loading">
        <LoaderCircle /> Checking GitHub…
      </div>
    );
  }
  if (!config?.configured) {
    return (
      <Alert>
        <GitBranch />
        <AlertTitle>GitHub App setup required</AlertTitle>
        <AlertDescription>
          Add the four GitHub App settings on this OKF Hub installation. Manual
          HTTPS Git remains available below.
          {config?.setupUrl && (
            <>
              <br />Setup URL: <code>{config.setupUrl}</code>
            </>
          )}
        </AlertDescription>
      </Alert>
    );
  }
  if (!Number.isSafeInteger(installationId)) {
    return (
      <div className="source-github-connect">
        <span className="source-connection-icon">
          <GitBranch />
        </span>
        <div>
          <h3>Connect GitHub</h3>
          <p>
            Choose exactly which repositories OKF Hub can read. Changes sync
            automatically; GitHub stays authoritative.
          </p>
        </div>
        <Button render={<a href={config.installUrl ?? "#"} />}>
          {hasConnectedRepository
            ? "Manage GitHub access"
            : "Choose repositories"}
          <ExternalLink />
        </Button>
      </div>
    );
  }
  return (
    <div className="source-github-picker">
      <div className="source-github-picker-heading">
        <div>
          <Badge variant="outline">
            <GitBranch /> GitHub connected
          </Badge>
          <h3>Choose knowledge to import</h3>
          <p>One repository and one OKF folder become one read-only source.</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          render={<a href={config.installUrl ?? "#"} />}
        >
          Change access <ExternalLink />
        </Button>
      </div>
      <div className="source-github-fields">
        <div>
          <Label htmlFor="github-repository">Repository</Label>
          <Select value={repositoryId} onValueChange={chooseRepository}>
            <SelectTrigger id="github-repository" className="w-full">
              <SelectValue
                placeholder={loading ? "Loading…" : "Choose a repository"}
              />
            </SelectTrigger>
            <SelectContent>
              {repositories.map((repository) => (
                <SelectItem key={repository.id} value={String(repository.id)}>
                  {repository.fullName}
                  {repository.private ? " · Private" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="github-folder">OKF folder</Label>
          <Select
            value={folder}
            onValueChange={(value) => setFolder(value ?? "")}
            disabled={!folders.length}
          >
            <SelectTrigger id="github-folder" className="w-full">
              <SelectValue
                placeholder={repositoryId
                  ? "Choose a folder"
                  : "Choose a repository first"}
              />
            </SelectTrigger>
            <SelectContent>
              {folders.map((item) => (
                <SelectItem key={item} value={item}>
                  {item === "." ? "Repository root" : item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {error && <p className="source-error" role="alert">{error}</p>}
      <div className="source-github-actions">
        <Button
          type="button"
          disabled={busy || loading || !repositoryId || !folder}
          onClick={() =>
            void onConnect(installationId, Number(repositoryId), folder)}
        >
          {busy ? "Connecting…" : "Connect source"}
        </Button>
      </div>
    </div>
  );
}

function SyncHistory({ source }: { source: RepositorySource }) {
  const syncs = source.syncs ?? [];
  return (
    <details className="source-documents source-sync-history">
      <summary>
        <span>
          <History /> Sync history
        </span>
        <Badge variant="secondary">{syncs.length}</Badge>
        <ChevronDown className="source-details-chevron" />
      </summary>
      {syncs.length
        ? (
          <Table aria-label="Sync history">
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Revision</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {syncs.map((sync) => (
                <TableRow key={sync.id}>
                  <TableCell>
                    {new Date(sync.startedAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{sync.trigger}</TableCell>
                  <TableCell>
                    <Badge
                      variant={sync.status === "failed"
                        ? "destructive"
                        : "outline"}
                    >
                      {sync.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <code>{sync.revision?.slice(0, 12) ?? "—"}</code>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
        : <p className="source-empty">No syncs yet.</p>}
    </details>
  );
}

export function RepositoryPanel(
  {
    source,
    imports,
    canManage,
    busy,
    scheduleBusy,
    error,
    onConnect,
    onRefresh,
    onDisconnect,
    onOpen,
    onSchedule,
  }: {
    source: RepositorySource | null;
    imports: ImportedConcept[];
    canManage: boolean;
    busy: boolean;
    scheduleBusy: boolean;
    error: string;
    onConnect: (
      source: RepositorySource | null,
      repositoryUrl: string,
      folder: string,
      username: string,
      token: string,
    ) => Promise<void>;
    onRefresh: (sourceId: string) => Promise<void>;
    onDisconnect: (source: RepositorySource) => Promise<void>;
    onOpen: (
      sourceId: string,
      path: string,
    ) => Promise<unknown>;
    onSchedule: (sourceId: string, intervalMinutes: number) => Promise<void>;
  },
) {
  const headingId = source
    ? `repository-heading-${source.id}`
    : "repository-heading-new";
  const connect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void onConnect(
      source,
      String(fields.get("repositoryUrl") ?? ""),
      String(fields.get("folder") ?? "okf"),
      String(fields.get("username") ?? ""),
      String(fields.get("token") ?? ""),
    );
  };
  const connectionForm = (
    <form className="source-form" onSubmit={connect}>
      <label>
        HTTPS Git URL
        <Input
          name="repositoryUrl"
          type="url"
          placeholder="https://example.com/company/knowledge.git"
          defaultValue={source?.repositoryUrl}
          required
        />
      </label>
      <label>
        OKF folder
        <Input name="folder" defaultValue={source?.folder ?? "okf"} required />
      </label>
      <label>
        Git username <span>(private repositories only)</span>
        <Input name="username" autoComplete="username" />
      </label>
      <label>
        Access token <span>(private repositories only)</span>
        <Input name="token" type="password" autoComplete="new-password" />
      </label>
      <Button
        variant="default"
        className="primary"
        type="submit"
        disabled={busy}
      >
        {busy
          ? "Connecting…"
          : source
          ? "Try different settings"
          : "Connect and import"}
      </Button>
    </form>
  );
  if (source) {
    const name = source.repositoryUrl.replace(/\.git$/, "").split("/")
      .filter(Boolean).at(-1) ?? "Git repository";
    return (
      <Card className="source-connection-card" aria-labelledby={headingId}>
        <CardHeader>
          <div className="source-connection-title">
            <span className="source-connection-icon">
              <GitBranch />
            </span>
            <div>
              <CardTitle id={headingId}>{name}</CardTitle>
              <CardDescription>{source.repositoryUrl}</CardDescription>
            </div>
          </div>
          <CardAction className="source-connection-actions">
            <Badge
              variant={source.status === "sync_failed"
                ? "destructive"
                : "outline"}
            >
              {source.status.replace("_", " ")}
            </Badge>
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={busy}
                onClick={() => void onRefresh(source.id)}
              >
                {busy ? "Refreshing…" : "Refresh"}
              </Button>
            )}
          </CardAction>
        </CardHeader>
        <CardContent>
          <dl className="source-meta-row">
            <div>
              <dt>Folder</dt>
              <dd>
                <FolderOpen /> {source.folder}
              </dd>
            </div>
            <div>
              <dt>Documents</dt>
              <dd>
                <FileText /> {source.conceptCount}
              </dd>
            </div>
            <div>
              <dt>Revision</dt>
              <dd>
                <code>{source.revision?.slice(0, 12) ?? "None"}</code>
              </dd>
            </div>
            <div>
              <dt>Last sync</dt>
              <dd>
                {source.lastSyncedAt
                  ? new Date(source.lastSyncedAt).toLocaleString()
                  : "Not yet"}
              </dd>
            </div>
            <div>
              <dt>Access</dt>
              <dd>
                {source.credentialsConfigured
                  ? source.kind === "github"
                    ? "GitHub App"
                    : "Private credentials stored"
                  : "Public HTTPS"}
              </dd>
            </div>
            <div>
              <dt>Automatic checks</dt>
              <dd>
                <SourceSchedule
                  sourceId={source.id}
                  value={source.automationIntervalMinutes}
                  busy={scheduleBusy}
                  canManage={canManage}
                  onChange={onSchedule}
                />
              </dd>
            </div>
          </dl>
          {source.error && (
            <p className="source-error" role="alert">{source.error}</p>
          )}
          <SourceIssues issues={source.issues} />
          <div className="source-connection-sections">
            <ImportList
              sourceId={source.id}
              imports={imports}
              onOpen={onOpen}
            />
            <SyncHistory source={source} />
            {canManage && (
              <details className="source-settings">
                <summary>
                  <span>
                    <Settings2 /> Connection settings
                  </span>
                  <ChevronDown className="source-details-chevron" />
                </summary>
                {source.kind === "github"
                  ? (
                    <p className="source-empty">
                      Repository access is managed by the GitHub App. Use Add
                      source to change the installation or connect another
                      repository.
                    </p>
                  )
                  : connectionForm}
                <Button
                  variant="destructive"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (
                      globalThis.confirm(
                        `Disconnect ${source.repositoryUrl}? This removes ${source.conceptCount} imported documents from OKF Hub.`,
                      )
                    ) void onDisconnect(source);
                  }}
                >
                  Disconnect repository
                </Button>
              </details>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <section className="source-card" aria-labelledby={headingId}>
      <div className="source-heading">
        <div>
          <p className="eyebrow">Git source</p>
          <h2 id={headingId}>Repository-owned OKF</h2>
          <p>
            Imported concepts stay read-only here. The Git repository remains
            authoritative.
          </p>
        </div>
      </div>
      {canManage
        ? connectionForm
        : <p className="source-empty">No repository has been connected.</p>}
      {error && <p className="source-error" role="alert">{error}</p>}
    </section>
  );
}

export function SharedStorePanel(
  {
    source,
    imports,
    canManage,
    busy,
    scheduleBusy,
    error,
    onConnect,
    onRefresh,
    onOpen,
    onSchedule,
  }: {
    source: SharedSource | null;
    imports: ImportedConcept[];
    canManage: boolean;
    busy: boolean;
    scheduleBusy: boolean;
    error: string;
    onConnect: (values: Record<string, string>) => Promise<void>;
    onRefresh: () => Promise<void>;
    onOpen: (
      sourceId: string,
      path: string,
    ) => Promise<unknown>;
    onSchedule: (sourceId: string, intervalMinutes: number) => Promise<void>;
  },
) {
  const connect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void onConnect({
      endpoint: String(fields.get("endpoint") ?? ""),
      bucket: String(fields.get("bucket") ?? ""),
      path: String(fields.get("path") ?? "okf"),
      region: String(fields.get("region") ?? "us-east-1"),
      accessKey: String(fields.get("accessKey") ?? ""),
      secretKey: String(fields.get("secretKey") ?? ""),
    });
  };
  const connectionForm = (
    <form className="source-form shared-source-form" onSubmit={connect}>
      <label>
        S3 endpoint
        <Input
          name="endpoint"
          type="url"
          placeholder="https://s3.example.com"
          defaultValue={source?.endpoint}
          required
        />
      </label>
      <label>
        Bucket
        <Input name="bucket" defaultValue={source?.bucket} required />
      </label>
      <label>
        OKF path
        <Input name="path" defaultValue={source?.path ?? "okf"} required />
      </label>
      <label>
        Region
        <Input
          name="region"
          defaultValue={source?.region ?? "us-east-1"}
          required
        />
      </label>
      <label>
        Access key
        <Input
          name="accessKey"
          autoComplete="off"
          required={!source?.credentialsConfigured}
        />
      </label>
      <label>
        Secret key
        <Input
          name="secretKey"
          type="password"
          autoComplete="new-password"
          required={!source?.credentialsConfigured}
        />
      </label>
      <Button
        variant="default"
        className="primary"
        type="submit"
        disabled={busy}
      >
        {busy
          ? "Connecting…"
          : source
          ? "Retry with these settings"
          : "Connect and import"}
      </Button>
    </form>
  );
  return (
    <section className="source-card" aria-labelledby="shared-heading">
      <div className="source-heading">
        <div>
          <p className="eyebrow">Shared store source</p>
          <h2 id="shared-heading">Shared controlled OKF</h2>
          <p>
            Import a portable OKF bundle directly from customer-controlled
            object storage, without GitHub.
          </p>
        </div>
        {source && canManage && (
          <Button
            className="primary"
            type="button"
            disabled={busy}
            onClick={() => void onRefresh()}
          >
            {busy ? "Refreshing…" : "Refresh shared store"}
          </Button>
        )}
      </div>
      {!source
        ? canManage
          ? connectionForm
          : <p className="source-empty">No shared store has been connected.</p>
        : (
          <>
            <dl className="source-provenance">
              <div>
                <dt>Status</dt>
                <dd className={`source-status ${source.status}`}>
                  {source.status.replace("_", " ")}
                </dd>
              </div>
              <div>
                <dt>Endpoint</dt>
                <dd>{source.endpoint}</dd>
              </div>
              <div>
                <dt>Bucket and path</dt>
                <dd>{source.bucket}/{source.path}</dd>
              </div>
              <div>
                <dt>Source revision</dt>
                <dd>
                  <code>{source.revision?.slice(0, 12) ?? "None"}</code>
                </dd>
              </div>
              <div>
                <dt>Last successful sync</dt>
                <dd>
                  {source.lastSyncedAt
                    ? new Date(source.lastSyncedAt).toLocaleString()
                    : "Not yet"}
                </dd>
              </div>
              <div>
                <dt>Credentials</dt>
                <dd>Encrypted and stored server-side</dd>
              </div>
              <div>
                <dt>Automatic checks</dt>
                <dd>
                  <SourceSchedule
                    sourceId="shared"
                    value={source.automationIntervalMinutes}
                    busy={scheduleBusy}
                    canManage={canManage}
                    onChange={onSchedule}
                  />
                </dd>
              </div>
            </dl>
            {source.error && (
              <p className="source-error" role="alert">{source.error}</p>
            )}
            <SourceIssues issues={source.issues} />
            {canManage && source.status === "sync_failed" &&
              !source.revision && connectionForm}
          </>
        )}
      {error && <p className="source-error" role="alert">{error}</p>}
      {source && (
        <ImportList sourceId="shared" imports={imports} onOpen={onOpen} />
      )}
    </section>
  );
}

function NotionPanel({
  source,
  imports,
  canManage,
  busy,
  scheduleBusy,
  error,
  onConnect,
  onRefresh,
  onOpen,
  onSchedule,
}: {
  source: NotionSource | null;
  imports: ImportedConcept[];
  canManage: boolean;
  busy: boolean;
  scheduleBusy: boolean;
  error: string;
  onConnect: (token: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onOpen: (sourceId: string, path: string) => Promise<unknown>;
  onSchedule: (sourceId: string, intervalMinutes: number) => Promise<void>;
}) {
  const connect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onConnect(
      String(new FormData(event.currentTarget).get("token") ?? ""),
    );
  };
  const form = (
    <form className="source-form" onSubmit={connect}>
      <label>
        Internal integration token
        <Input
          name="token"
          type="password"
          autoComplete="new-password"
          placeholder="ntn_…"
          required
        />
      </label>
      <p className="source-form-help">
        Share the pages you want indexed with this Notion integration.
      </p>
      <Button className="primary" type="submit" disabled={busy}>
        {busy ? "Connecting…" : source ? "Replace token" : "Connect and import"}
      </Button>
    </form>
  );
  return (
    <section className="source-card" aria-labelledby="notion-heading">
      <div className="source-heading">
        <div>
          <p className="eyebrow">Workspace source</p>
          <h2 id="notion-heading">Notion</h2>
          <p>
            Import pages shared with an internal integration as read-only
            knowledge.
          </p>
        </div>
        {source && canManage && (
          <Button
            className="primary"
            type="button"
            disabled={busy}
            onClick={() => void onRefresh()}
          >
            {busy ? "Refreshing…" : "Refresh Notion"}
          </Button>
        )}
      </div>
      {source
        ? (
          <>
            <dl className="source-provenance">
              <div>
                <dt>Status</dt>
                <dd className={`source-status ${source.status}`}>
                  {source.status.replace("_", " ")}
                </dd>
              </div>
              <div>
                <dt>Source revision</dt>
                <dd>
                  <code>{source.revision?.slice(0, 12) ?? "None"}</code>
                </dd>
              </div>
              <div>
                <dt>Last successful sync</dt>
                <dd>
                  {source.lastSyncedAt
                    ? new Date(source.lastSyncedAt).toLocaleString()
                    : "Not yet"}
                </dd>
              </div>
              <div>
                <dt>Credentials</dt>
                <dd>Encrypted and stored server-side</dd>
              </div>
              <div>
                <dt>Automatic checks</dt>
                <dd>
                  <SourceSchedule
                    sourceId="notion"
                    value={source.automationIntervalMinutes}
                    busy={scheduleBusy}
                    canManage={canManage}
                    onChange={onSchedule}
                  />
                </dd>
              </div>
            </dl>
            {source.error && (
              <p className="source-error" role="alert">{source.error}</p>
            )}
            <SourceIssues issues={source.issues} />
            {canManage && form}
          </>
        )
        : canManage
        ? form
        : <p className="source-empty">Notion is not connected.</p>}
      {error && <p className="source-error" role="alert">{error}</p>}
      {source && (
        <ImportList sourceId="notion" imports={imports} onOpen={onOpen} />
      )}
    </section>
  );
}

function ConnectorForm({
  connector,
  busy,
  onConnect,
}: {
  connector: ConnectorDefinition;
  busy: boolean;
  onConnect: (
    connector: ConnectorDefinition,
    values: Record<string, string>,
  ) => Promise<void>;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void onConnect(
      connector,
      Object.fromEntries(
        connector.fields.map((field) => [
          field.name,
          String(data.get(field.name) ?? field.defaultValue ?? ""),
        ]),
      ),
    );
  };
  return (
    <form className="source-form" onSubmit={submit}>
      {connector.fields.map((field) => (
        <label key={field.name}>
          {field.label}
          <Input
            name={field.name}
            type={field.type}
            placeholder={field.placeholder}
            defaultValue={field.defaultValue}
            autoComplete={field.secret ? "new-password" : undefined}
            required={field.required}
          />
        </label>
      ))}
      <Button className="primary" type="submit" disabled={busy}>
        {busy ? "Connecting…" : "Connect and import"}
      </Button>
    </form>
  );
}

function ConnectorCatalog({
  connectors,
  repositories,
  sharedSource,
  notionSource,
  busy,
  onConnect,
  onSetEnabled,
  github,
}: {
  connectors: ConnectorDefinition[];
  repositories: RepositorySource[];
  sharedSource: SharedSource | null;
  notionSource: NotionSource | null;
  busy: boolean;
  onConnect: (
    connector: ConnectorDefinition,
    values: Record<string, string>,
  ) => Promise<void>;
  onSetEnabled: (id: string, enabled: boolean) => Promise<void>;
  github: React.ReactNode;
}) {
  const instances = (connector: ConnectorDefinition) =>
    connector.id === "git"
      ? repositories.map((source) => ({
        id: source.id,
        label: source.githubFullName ??
          source.repositoryUrl.replace(/\.git$/, "")
            .split("/").filter(Boolean).at(-1) ??
          "Git repository",
        detail: `${source.folder} · ${source.conceptCount} document${
          source.conceptCount === 1 ? "" : "s"
        }`,
        status: source.status,
      }))
      : connector.id === "s3" && sharedSource
      ? [{
        id: sharedSource.id,
        label: sharedSource.bucket,
        detail: `${sharedSource.path} · ${sharedSource.conceptCount} document${
          sharedSource.conceptCount === 1 ? "" : "s"
        }`,
        status: sharedSource.status,
      }]
      : connector.id === "notion" && notionSource
      ? [{
        id: notionSource.id,
        label: "Notion workspace",
        detail: `${notionSource.conceptCount} document${
          notionSource.conceptCount === 1 ? "" : "s"
        }`,
        status: notionSource.status,
      }]
      : [];
  return (
    <div className="source-connected-list">
      {connectors.map((connector) => {
        const connected = instances(connector);
        const setupLabel = connected.length && connector.id !== "git"
          ? "Update connection"
          : "Add connection";
        return (
          <Card key={connector.id} className="source-connection-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {connector.title}
                {connected.length > 0 && (
                  <Badge variant="secondary">
                    {connected.length} connected
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                {connector.description}
                <span className="mt-2 flex gap-2">
                  {connector.capabilities.map((capability) => (
                    <Badge key={capability} variant="outline">
                      {capability}
                    </Badge>
                  ))}
                </span>
              </CardDescription>
              <CardAction>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Switch
                    aria-label={`Enable ${connector.title}`}
                    checked={connector.enabled}
                    onCheckedChange={(checked) =>
                      void onSetEnabled(connector.id, checked)}
                  />
                  Enabled
                </label>
              </CardAction>
            </CardHeader>
            <CardContent className="grid gap-4">
              {connected.length > 0 && (
                <div
                  className="grid gap-2"
                  aria-label={`${connector.title} connections`}
                >
                  {connected.map((source) => (
                    <div
                      key={source.id}
                      className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <strong className="block truncate text-sm">
                          {source.label}
                        </strong>
                        <span className="text-xs text-muted-foreground">
                          {source.detail}
                        </span>
                      </div>
                      <Badge
                        variant={source.status === "current"
                          ? "secondary"
                          : "outline"}
                      >
                        {source.status.replace("_", " ")}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
              {connector.enabled && connector.connectPath && (
                <details className="rounded-lg border bg-muted/20">
                  <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-sm font-medium">
                    <Plus className="size-4" /> {setupLabel}
                  </summary>
                  <div className="grid gap-4 border-t p-3">
                    {connector.setup === "github-app" && github}
                    <ConnectorForm
                      connector={connector}
                      busy={busy}
                      onConnect={onConnect}
                    />
                  </div>
                </details>
              )}
              {connector.enabled && !connector.connectPath && (
                <p className="source-form-help">
                  This connector applies automatically to supported links.
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export function ConnectorSettings({
  connectors,
  repositories,
  sharedSource,
  notionSource,
  busy,
  onConnect,
  onSetEnabled,
  onConnectGitHub,
}: {
  connectors: ConnectorDefinition[];
  repositories: RepositorySource[];
  sharedSource: SharedSource | null;
  notionSource: NotionSource | null;
  busy: boolean;
  onConnect: (
    connector: ConnectorDefinition,
    values: Record<string, string>,
  ) => Promise<void>;
  onSetEnabled: (id: string, enabled: boolean) => Promise<void>;
  onConnectGitHub: (
    installationId: number,
    repositoryId: number,
    folder: string,
  ) => Promise<void>;
}) {
  const imports = connectors.filter((connector) =>
    connector.capabilities.includes("import")
  );
  const embeds = connectors.filter((connector) =>
    connector.capabilities.includes("embed")
  );
  const catalog = (items: ConnectorDefinition[]) => (
    <ConnectorCatalog
      connectors={items}
      repositories={repositories}
      sharedSource={sharedSource}
      notionSource={notionSource}
      busy={busy}
      onConnect={onConnect}
      onSetEnabled={onSetEnabled}
      github={
        <GitHubConnectPanel
          busy={busy}
          hasConnectedRepository={repositories.some((source) =>
            source.kind === "github"
          )}
          onConnect={onConnectGitHub}
        />
      }
    />
  );
  return (
    <Tabs defaultValue="imports" className="gap-4">
      <TabsList variant="line" aria-label="Connector types">
        <TabsTrigger value="imports">
          Imports <Badge variant="secondary">{imports.length}</Badge>
        </TabsTrigger>
        <TabsTrigger value="embeds">
          Embeds <Badge variant="secondary">{embeds.length}</Badge>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="imports" className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Import source-owned knowledge into the permission-aware index.
        </p>
        {catalog(imports)}
      </TabsContent>
      <TabsContent value="embeds" className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Turn supported links into live previews without changing stored
          Markdown.
        </p>
        {catalog(embeds)}
      </TabsContent>
    </Tabs>
  );
}

export function AutomationPanel() {
  const [state, setState] = useState<AutomationState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await api("/api/automation");
    const result = await response.json() as AutomationState & {
      error?: string;
    };
    if (!response.ok) throw new Error(result.error ?? "Automation unavailable");
    setState(result);
  }, []);
  useEffect(() => {
    load().catch((cause) => setError(cause.message));
  }, [load]);
  const run = async () => {
    setBusy(true);
    setError("");
    const response = await api("/api/automation/run", { method: "POST" });
    const result = await response.json() as AutomationState & {
      error?: string;
    };
    setBusy(false);
    if (!response.ok) {
      setError(result.error ?? "Source checks failed");
      return;
    }
    setState(result);
  };
  return (
    <section className="automation-panel" aria-labelledby="automation-heading">
      <div className="source-heading">
        <div>
          <p className="eyebrow">Source operations</p>
          <h2 id="automation-heading">Checks and proposals</h2>
          <p>
            Each source follows its own schedule and receives at most one
            automatic retry. Change a cadence from the Connected tab.
          </p>
        </div>
        <Button
          className="primary"
          type="button"
          disabled={busy || state?.running}
          onClick={() =>
            void run()}
        >
          {busy || state?.running ? "Running checks…" : "Run checks now"}
        </Button>
      </div>
      {error && <p className="source-error" role="alert">{error}</p>}
      <div className="automation-runs">
        {state?.runs.map((run, index) => (
          <details key={run.id} open={index === 0}>
            <summary>
              <strong className={`automation-status ${run.status}`}>
                {run.status}
              </strong>
              <span>{run.trigger}</span>
              <time>{new Date(run.startedAt).toLocaleString()}</time>
            </summary>
            <div className="automation-attempts">
              {run.attempts.map((attempt) => (
                <section key={attempt.id}>
                  <div>
                    <strong>
                      {attempt.job === "source_check"
                        ? `${attempt.sourceId} source`
                        : "Broken links"}
                    </strong>
                    <span>
                      Attempt {attempt.attempt} · {attempt.status}
                    </span>
                  </div>
                  {attempt.error && <p>{attempt.error}</p>}
                  {attempt.result?.conceptCount !== undefined && (
                    <p>
                      {attempt.result.conceptCount} healthy concepts indexed
                    </p>
                  )}
                  {attempt.result?.checkedConcepts !== undefined && (
                    <p>{attempt.result.checkedConcepts} concepts checked</p>
                  )}
                  {attempt.result?.proposals?.map((proposal) => (
                    <div
                      className="automation-proposal"
                      key={`${proposal.sourceId}-${proposal.path}-${proposal.href}`}
                    >
                      <strong>Fix broken link</strong>
                      <code>{proposal.path}</code>
                      <span>{proposal.href} → {proposal.target}</span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </details>
        ))}
        {state && state.runs.length === 0 && (
          <p className="source-empty">No source checks have run yet.</p>
        )}
      </div>
    </section>
  );
}

export function SourceWorkspace(
  {
    repositories,
    sharedSource,
    notionSource,
    connectors,
    imports,
    canManage,
    sourceBusy,
    sharedBusy,
    notionBusy,
    sourceError,
    sharedError,
    notionError,
    scheduleBusyId,
    onConnectRepository,
    onConnectGitHub,
    onRefreshRepository,
    onDisconnectRepository,
    onConnectShared,
    onRefreshShared,
    onConnectNotion,
    onRefreshNotion,
    onConnectConnector,
    onSetConnectorEnabled,
    onUpdateSchedule,
    onOpen,
  }: {
    repositories: RepositorySource[];
    sharedSource: SharedSource | null;
    notionSource: NotionSource | null;
    connectors: ConnectorDefinition[];
    imports: ImportedConcept[];
    canManage: boolean;
    sourceBusy: boolean;
    sharedBusy: boolean;
    notionBusy: boolean;
    sourceError: string;
    sharedError: string;
    notionError: string;
    scheduleBusyId: string | null;
    onConnectRepository: (
      source: RepositorySource | null,
      repositoryUrl: string,
      folder: string,
      username: string,
      token: string,
    ) => Promise<void>;
    onConnectGitHub: (
      installationId: number,
      repositoryId: number,
      folder: string,
    ) => Promise<void>;
    onRefreshRepository: (sourceId: string) => Promise<void>;
    onDisconnectRepository: (source: RepositorySource) => Promise<void>;
    onConnectShared: (values: Record<string, string>) => Promise<void>;
    onRefreshShared: () => Promise<void>;
    onConnectNotion: (token: string) => Promise<void>;
    onRefreshNotion: () => Promise<void>;
    onConnectConnector: (
      connector: ConnectorDefinition,
      values: Record<string, string>,
    ) => Promise<void>;
    onSetConnectorEnabled: (id: string, enabled: boolean) => Promise<void>;
    onUpdateSchedule: (
      sourceId: string,
      intervalMinutes: number,
    ) => Promise<void>;
    onOpen: (sourceId: string, path: string) => Promise<unknown>;
  },
) {
  const connectedCount = repositories.length + Number(Boolean(sharedSource)) +
    Number(Boolean(notionSource));
  const healthyCount =
    repositories.filter((source) => source.status === "current")
      .length +
    Number(sharedSource?.status === "current") +
    Number(notionSource?.status === "current");
  const [view, setView] = useState<"connected" | "add" | "health">(
    connectedCount ? "connected" : "add",
  );
  const previousConnectedCount = useRef(connectedCount);
  useEffect(() => {
    if (previousConnectedCount.current === 0 && connectedCount > 0) {
      setView("connected");
    }
    previousConnectedCount.current = connectedCount;
  }, [connectedCount]);
  return (
    <div className="source-panel source-workspace">
      <header className="source-page-heading">
        <div>
          <p className="eyebrow">Connected knowledge</p>
          <h1>Knowledge sources</h1>
          <p>
            Bring authoritative OKF into one permission-aware index. Imported
            documents remain read-only.
          </p>
        </div>
        {canManage && view !== "add" && (
          <Button
            type="button"
            onClick={() => setView("add")}
          >
            <Plus /> Add source
          </Button>
        )}
      </header>
      <div className="source-summary" aria-label="Source summary">
        <span>
          <Database /> {connectedCount} source{connectedCount === 1 ? "" : "s"}
        </span>
        <span>
          <HeartPulse /> {healthyCount} healthy
        </span>
        <span>
          <FileText /> {imports.length} documents
        </span>
      </div>
      {(sourceError || sharedError || notionError) && (
        <p className="source-error" role="alert">
          {sourceError || sharedError || notionError}
        </p>
      )}
      <Tabs
        value={view}
        onValueChange={(value) => setView(value as typeof view)}
        className="source-tabs"
      >
        <TabsList variant="line" aria-label="Source sections">
          <TabsTrigger value="connected">
            Connected <Badge variant="secondary">{connectedCount}</Badge>
          </TabsTrigger>
          {canManage && <TabsTrigger value="add">Add source</TabsTrigger>}
          {canManage && connectedCount > 0 && (
            <TabsTrigger value="health">Sync health</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="connected" className="source-tab-content">
          {connectedCount === 0
            ? (
              <Card className="source-empty-card">
                <GitBranch />
                <h2>No sources connected</h2>
                <p>
                  Connect Git or S3-compatible storage to index existing OKF
                  without moving ownership into the hub.
                </p>
                {canManage && (
                  <Button
                    type="button"
                    onClick={() => setView("add")}
                  >
                    <Plus /> Connect a source
                  </Button>
                )}
              </Card>
            )
            : (
              <div className="source-connected-list">
                {repositories.map((source) => (
                  <RepositoryPanel
                    key={source.id}
                    source={source}
                    imports={imports}
                    canManage={canManage}
                    busy={sourceBusy}
                    scheduleBusy={scheduleBusyId === source.id}
                    error=""
                    onConnect={onConnectRepository}
                    onRefresh={onRefreshRepository}
                    onDisconnect={onDisconnectRepository}
                    onOpen={onOpen}
                    onSchedule={onUpdateSchedule}
                  />
                ))}
                {sharedSource && (
                  <SharedStorePanel
                    source={sharedSource}
                    imports={imports}
                    canManage={canManage}
                    busy={sharedBusy}
                    scheduleBusy={scheduleBusyId === "shared"}
                    error={sharedError}
                    onConnect={onConnectShared}
                    onRefresh={onRefreshShared}
                    onOpen={onOpen}
                    onSchedule={onUpdateSchedule}
                  />
                )}
                {notionSource && (
                  <NotionPanel
                    source={notionSource}
                    imports={imports}
                    canManage={canManage}
                    busy={notionBusy}
                    scheduleBusy={scheduleBusyId === "notion"}
                    error={notionError}
                    onConnect={onConnectNotion}
                    onRefresh={onRefreshNotion}
                    onOpen={onOpen}
                    onSchedule={onUpdateSchedule}
                  />
                )}
              </div>
            )}
        </TabsContent>
        {canManage && (
          <TabsContent value="add" className="source-tab-content">
            <Card className="source-picker">
              <CardHeader>
                <CardTitle>Choose where your OKF lives</CardTitle>
                <CardDescription>
                  Credentials are encrypted server-side. The source stays
                  authoritative.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ConnectorSettings
                  connectors={connectors}
                  repositories={repositories}
                  sharedSource={sharedSource}
                  notionSource={notionSource}
                  busy={sourceBusy || sharedBusy || notionBusy}
                  onConnect={onConnectConnector}
                  onSetEnabled={onSetConnectorEnabled}
                  onConnectGitHub={onConnectGitHub}
                />
              </CardContent>
            </Card>
          </TabsContent>
        )}
        {canManage && connectedCount > 0 && (
          <TabsContent value="health" className="source-tab-content">
            <AutomationPanel />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function grantAllows(grants: string[], name: string) {
  return grants.some((grant) =>
    grant === name ||
    (grant.endsWith(".*") && name.startsWith(grant.slice(0, -1)))
  );
}

type AvailableAction = NonNullable<ArtifactState["availableActions"]>[number];

const BUNDLE_PREFIX = "okf-bundle-v1:";

type BrowserFile = File & { webkitRelativePath?: string };

async function appBundle(files: File[]) {
  if (!files.length) throw new Error("Choose an app folder or files");
  const paths = files.map((file) =>
    (file as BrowserFile).webkitRelativePath || file.name
  );
  const firstParts = paths.map((path) =>
    path.replaceAll("\\", "/").split("/")[0]
  );
  const sharedRoot = firstParts.every((part) => part === firstParts[0]) &&
      paths.every((path) => path.includes("/"))
    ? `${firstParts[0]}/`
    : "";
  const packed = await Promise.all(files.map(async (file, index) => {
    const path = paths[index].replaceAll("\\", "/").slice(sharedRoot.length);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    const type = file.type || "application/octet-stream";
    return { path, type, data: `data:${type};base64,${btoa(binary)}` };
  }));
  const entry = packed.find((file) => file.path.toLowerCase() === "index.html")
    ?.path;
  if (!entry) throw new Error("The app folder needs an index.html file");
  return {
    content: `${BUNDLE_PREFIX}${JSON.stringify({ entry, files: packed })}`,
    entry,
    files: packed.map((file) => file.path),
    folder: sharedRoot.replace(/\/$/, ""),
    bytes: files.reduce((total, file) => total + file.size, 0),
  };
}

const formatBytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const appFileUrl = (artifact: Artifact) =>
  `${SERVICE}/api/apps/${encodeURIComponent(artifact.id)}/files/${
    artifact.bundle?.entry.split("/").map(encodeURIComponent).join("/") ?? ""
  }`;

function CapabilityPicker({
  actions,
  grants,
  onChange,
}: {
  actions: AvailableAction[];
  grants: string[];
  onChange: (grants: string[]) => void;
}) {
  const toggle = (name: string, checked: boolean) =>
    onChange(
      checked
        ? Array.from(new Set([...grants, name]))
        : grants.filter((grant) => grant !== name),
    );
  const queries = actions.filter((action) => action.mode === "query");
  const mutations = actions.filter((action) => action.mode === "mutation");
  const group = (title: string, items: AvailableAction[]) => (
    <section className="app-capability-group">
      <h4>{title}</h4>
      {items.map((action) => (
        <Label className="app-capability" key={action.name}>
          <Checkbox
            checked={grantAllows(grants, action.name)}
            onCheckedChange={(checked) =>
              toggle(action.name, checked)}
          />
          <span>
            <strong>{action.title}</strong>
            <small>{action.description}</small>
          </span>
        </Label>
      ))}
    </section>
  );
  return (
    <div className="app-capabilities">
      <div className="app-builder-section-heading">
        <div>
          <h3>Capabilities</h3>
          <p>Apps can only call operations you explicitly grant.</p>
        </div>
        <Badge variant="outline">
          <ShieldCheck /> Least privilege
        </Badge>
      </div>
      <div className="app-capability-columns">
        {group("Read", queries)}
        {group("Change", mutations)}
      </div>
    </div>
  );
}

function AppFrame({ artifact }: { artifact: Artifact }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const receive = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = event.data as {
        type?: unknown;
        id?: unknown;
        name?: unknown;
        input?: unknown;
      };
      if (
        message?.type !== "okf:action" || typeof message.id !== "string" ||
        typeof message.name !== "string"
      ) return;
      const reply = (body: Record<string, unknown>) =>
        frame.current?.contentWindow?.postMessage({
          type: "okf:result",
          id: message.id,
          ...body,
        }, "*");
      if (!grantAllows(artifact.grants, message.name)) {
        reply({ error: `App is not allowed to call ${message.name}` });
        return;
      }
      const input = message.input && typeof message.input === "object" &&
          !Array.isArray(message.input)
        ? { ...message.input as Record<string, unknown> }
        : {};
      if (message.name.startsWith("app.data.")) input.appId = artifact.id;
      const response = await api(
        `/api/v1/actions/${encodeURIComponent(message.name)}`,
        { method: "POST", body: JSON.stringify(input) },
      );
      const result = await response.json().catch(() => ({})) as {
        result?: unknown;
        error?: string;
      };
      reply(
        response.ok
          ? { result: result.result }
          : { error: result.error ?? "App action failed" },
      );
    };
    globalThis.addEventListener("message", receive);
    return () => globalThis.removeEventListener("message", receive);
  }, [artifact.grants, artifact.id]);
  return (
    <iframe
      ref={frame}
      className="artifact-frame"
      title={artifact.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      allow=""
      loading="lazy"
      src={artifact.bundle
        ? appFileUrl(artifact)
        : artifact.type === "https_url"
        ? artifact.url
        : undefined}
      srcDoc={artifact.type === "inline_html" && !artifact.bundle
        ? artifact.document
        : undefined}
    />
  );
}

export function AppPanel(
  { conceptId, conceptActive, onInsertReference }: {
    conceptId: string;
    conceptActive: boolean;
    onInsertReference?: (artifact: Artifact) => void;
  },
) {
  const [state, setState] = useState<ArtifactState | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<Artifact | null>(null);
  const [type, setType] = useState<"inline_html" | "https_url">("inline_html");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [bundleFiles, setBundleFiles] = useState<string[]>([]);
  const [bundleBytes, setBundleBytes] = useState(0);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const [grants, setGrants] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await api(
      `/api/apps?conceptId=${encodeURIComponent(conceptId)}`,
    );
    const result = await response.json() as ArtifactState & { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Apps unavailable");
    setState(result);
  }, [conceptId]);
  useEffect(() => {
    load().catch((cause) => setError(cause.message));
  }, [load]);

  const openBuilder = (artifact?: Artifact) => {
    const selected = artifact ?? null;
    setEditing(selected);
    setType(selected?.type ?? "inline_html");
    setTitle(selected?.title ?? "");
    setDescription(selected?.description ?? "");
    setContent(
      selected?.content ?? "",
    );
    setBundleFiles(selected?.bundle?.files ?? []);
    setBundleBytes(0);
    setGrants(selected?.grants ?? []);
    setError("");
    setBuilderOpen(true);
  };

  const chooseType = (next: "inline_html" | "https_url") => {
    setType(next);
    if (!editing) {
      setContent(next === "inline_html" ? "" : "https://");
      setBundleFiles([]);
      setBundleBytes(0);
    }
  };

  const selectBundle = async (selected: File[]) => {
    try {
      const bundle = await appBundle(selected);
      setContent(bundle.content);
      setBundleFiles(bundle.files);
      setBundleBytes(bundle.bytes);
      if (!title && bundle.folder) setTitle(bundle.folder.replaceAll("-", " "));
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "App bundle is invalid",
      );
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (type === "inline_html" && !content.startsWith(BUNDLE_PREFIX)) {
      setError("Choose an app folder containing index.html");
      return;
    }
    setBusy(editing?.id ?? "create");
    setError("");
    const response = await api(
      editing ? `/api/apps/${editing.id}` : "/api/apps",
      {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify({
          ...(editing ? {} : { documentId: conceptId, title }),
          description,
          grants,
          type,
          content,
        }),
      },
    );
    const result = await response.json().catch(() => ({})) as {
      error?: string;
    };
    setBusy("");
    if (!response.ok) {
      setError(
        result.error ?? (editing ? "App update failed" : "App creation failed"),
      );
      return;
    }
    setBuilderOpen(false);
    await load();
  };
  const publish = async (artifact: Artifact) => {
    setBusy(artifact.id);
    setError("");
    const response = await api(`/api/apps/${artifact.id}/activate`, {
      method: "POST",
    });
    const result = await response.json().catch(() => ({})) as {
      error?: string;
    };
    setBusy("");
    if (!response.ok) {
      setError(result.error ?? "App activation failed");
      return;
    }
    await load();
  };

  if (!state) {
    return error
      ? <p className="source-error" role="alert">{error}</p>
      : <div className="artifact-loading">Loading Apps…</div>;
  }
  if (!state.canEdit && state.artifacts.length === 0) return null;
  const apps = state.apps ?? state.artifacts;
  return (
    <section className="artifact-panel" aria-labelledby="artifact-heading">
      <div className="artifact-heading">
        <div>
          <p className="eyebrow">Document apps</p>
          <h2 id="artifact-heading">Tools for this knowledge</h2>
          <p>
            Add focused tools without putting executable code in the document.
            Every App is sandboxed, versioned, and explicitly approved.
          </p>
        </div>
        {state.canEdit && conceptActive && (
          <Button
            type="button"
            onClick={() => openBuilder()}
          >
            <Plus /> Add App
          </Button>
        )}
      </div>
      {error && <p className="source-error" role="alert">{error}</p>}
      {!apps.length && (
        <Card className="app-empty-state">
          <CardContent>
            <span className="app-empty-icon">
              <Sparkles />
            </span>
            <h3>No Apps attached</h3>
            <p>
              Upload a folder of static files, or connect a hosted tool. Readers
              only see versions you activate.
            </p>
            {state.canEdit && conceptActive && (
              <Button
                type="button"
                onClick={() => openBuilder()}
              >
                <Plus /> Add your first App
              </Button>
            )}
          </CardContent>
        </Card>
      )}
      <div className="app-grid">
        {apps.map((artifact) => (
          <Card key={`${artifact.id}-${artifact.version}`}>
            <CardHeader>
              <span className="app-card-icon">
                {artifact.type === "inline_html" ? <Code2 /> : <AppWindow />}
              </span>
              <CardTitle>{artifact.title}</CardTitle>
              <CardDescription>
                {artifact.description || "No purpose has been added yet."}
              </CardDescription>
              <CardAction className="app-card-badges">
                <Badge
                  variant={artifact.status === "live" ? "default" : "secondary"}
                >
                  {artifact.status.replace("_", " ")}
                </Badge>
                <Badge variant="outline">v{artifact.version}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent>
              <AppFrame artifact={artifact} />
            </CardContent>
            <CardFooter className="app-card-actions">
              {state.canEdit && conceptActive && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => openBuilder(artifact)}
                >
                  <Settings2 /> Configure
                </Button>
              )}
              {state.canEdit && conceptActive && onInsertReference && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onInsertReference(artifact)}
                >
                  <ExternalLink /> Insert reference
                </Button>
              )}
              {state.canPublish && artifact.status !== "live" && (
                <Button
                  type="button"
                  disabled={busy === artifact.id}
                  onClick={() => void publish(artifact)}
                >
                  Activate v{artifact.version}
                </Button>
              )}
            </CardFooter>
          </Card>
        ))}
      </div>

      <Dialog open={builderOpen} onOpenChange={setBuilderOpen}>
        <DialogContent className="app-builder-dialog sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              {editing ? `Configure ${editing.title}` : "Add an App"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "Saving creates a reviewable version. The live version is unchanged until activation."
                : "Upload a folder or select its files. OKF keeps them together as one reviewable App version."}
            </DialogDescription>
          </DialogHeader>
          <form className="app-builder" onSubmit={(event) => void save(event)}>
            <Tabs
              value={type}
              onValueChange={(value) => chooseType(value as typeof type)}
            >
              <TabsList className="app-kind-tabs">
                <TabsTrigger value="https_url">
                  <AppWindow /> Hosted app
                </TabsTrigger>
                <TabsTrigger value="inline_html">
                  <FolderOpen /> Upload bundle
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="app-builder-fields">
              <Label>
                <span>Name</span>
                <Input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={100}
                  disabled={Boolean(editing)}
                  required
                />
              </Label>
              <Label>
                <span>Purpose</span>
                <Input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={240}
                  placeholder="What this helps readers do"
                />
              </Label>
            </div>
            {type === "https_url"
              ? (
                <section className="app-builder-connect">
                  <div className="app-builder-section-heading">
                    <div>
                      <h3>Connection</h3>
                      <p>Only approved HTTPS hosts can be embedded.</p>
                    </div>
                    <Badge variant="secondary">Recommended</Badge>
                  </div>
                  <Label>
                    <span>App URL</span>
                    <Input
                      type="url"
                      value={content}
                      onChange={(event) => setContent(event.target.value)}
                      placeholder="https://app.example.com"
                      required
                    />
                  </Label>
                  <p className="app-allowed-hosts">
                    Allowed hosts:{" "}
                    {state.allowedHosts.join(", ") || "none configured"}
                  </p>
                </section>
              )
              : (
                <section className="app-bundle-workbench">
                  <div className="app-builder-section-heading">
                    <div>
                      <h3>App bundle</h3>
                      <p>
                        Upload a folder of static web files. It must include
                        index.html.
                      </p>
                    </div>
                    <Badge variant="outline">No-build bundle</Badge>
                  </div>
                  <div
                    className="app-bundle-drop"
                    tabIndex={0}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      void selectBundle(Array.from(event.dataTransfer.files));
                    }}
                    onPaste={(event) => {
                      const files = Array.from(event.clipboardData.files);
                      if (files.length) void selectBundle(files);
                    }}
                  >
                    <span className="app-bundle-icon">
                      <FileUp />
                    </span>
                    <div>
                      <h4>Drop or paste an app folder</h4>
                      <p>
                        No build pipeline or configuration file. Static assets
                        are kept together as one reviewed version.
                      </p>
                    </div>
                    <div className="app-bundle-buttons">
                      <Button
                        type="button"
                        onClick={() => folderInput.current?.click()}
                      >
                        <FolderOpen /> Choose folder
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => filesInput.current?.click()}
                      >
                        Choose files
                      </Button>
                    </div>
                    <input
                      ref={folderInput}
                      className="sr-only"
                      type="file"
                      multiple
                      onChange={(event) =>
                        void selectBundle(Array.from(event.target.files ?? []))}
                      {...{ webkitdirectory: "", directory: "" }}
                    />
                    <input
                      ref={filesInput}
                      className="sr-only"
                      type="file"
                      multiple
                      onChange={(event) =>
                        void selectBundle(Array.from(event.target.files ?? []))}
                    />
                  </div>
                  {bundleFiles.length > 0 && (
                    <div className="app-bundle-manifest">
                      <div>
                        <strong>{bundleFiles.length} files ready</strong>
                        <span>
                          {bundleBytes
                            ? formatBytes(bundleBytes)
                            : "Existing draft bundle"}
                        </span>
                      </div>
                      <ul>
                        {bundleFiles.slice(0, 8).map((file) => (
                          <li key={file}>{file}</li>
                        ))}
                        {bundleFiles.length > 8 && (
                          <li>+{bundleFiles.length - 8} more</li>
                        )}
                      </ul>
                    </div>
                  )}
                </section>
              )}
            {state.availableActions && (
              <CapabilityPicker
                actions={state.availableActions}
                grants={grants}
                onChange={setGrants}
              />
            )}
            {error && <p className="source-error" role="alert">{error}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setBuilderOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={Boolean(busy)}>
                {busy
                  ? "Saving…"
                  : editing
                  ? "Save new version"
                  : "Create draft App"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
