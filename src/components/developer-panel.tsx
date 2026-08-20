import {
  BookOpen,
  Check,
  Copy,
  KeyRound,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import {
  type FormEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
} from "react";
import { api, SERVICE } from "../lib/api.ts";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button, buttonVariants } from "./ui/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table.tsx";

type Action = {
  name: string;
  title: string;
  description: string;
  mode: "query" | "mutation";
  approval: "none" | "confirm";
  inputSchema: {
    type?: string;
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
    required?: string[];
  };
};
type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

const ScalarApiReference = lazy(() =>
  Promise.all([
    import("@scalar/api-reference-react"),
    import("@scalar/api-reference-react/style.css"),
  ]).then(([{ ApiReferenceReact }]) => ({ default: ApiReferenceReact }))
);

const scalarTheme = `
:root {
  --scalar-font: "Geist Variable", Arial, sans-serif;
  --scalar-font-code: ui-monospace, SFMono-Regular, Menlo, monospace;
  --scalar-background-1: var(--card);
  --scalar-background-2: var(--muted);
  --scalar-background-3: color-mix(in srgb, var(--muted) 82%, var(--foreground));
  --scalar-background-accent: color-mix(in srgb, var(--primary) 10%, transparent);
  --scalar-color-1: var(--foreground);
  --scalar-color-2: var(--muted-foreground);
  --scalar-color-3: var(--muted-foreground);
  --scalar-color-accent: var(--primary);
  --scalar-border-color: var(--border);
  --scalar-radius: 8px;
}
.section-content > .flex.flex-row:first-child {
  margin-bottom: 0.75rem;
}
`;

function ApiDocumentation() {
  return (
    <div className="scalar-reference">
      <Suspense
        fallback={
          <div className="scalar-reference-loading" role="status">
            <BookOpen />
            <span>Loading API reference…</span>
          </div>
        }
      >
        <ScalarApiReference
          configuration={{
            url: `${SERVICE}/api/openapi.json`,
            servers: [{ url: SERVICE, description: "Current OKF Hub" }],
            layout: "modern",
            theme: "none",
            showDeveloperTools: "never",
            agent: { disabled: true },
            mcp: { disabled: true },
            hideClientButton: true,
            hideDarkModeToggle: true,
            forceDarkModeState: "light",
            documentDownloadType: "direct",
            defaultOpenFirstTag: true,
            hideSearch: true,
            showOperationId: true,
            withDefaultFonts: false,
            telemetry: false,
            customCss: scalarTheme,
            customFetch: (input, init) =>
              fetch(input, { ...init, credentials: "include" }),
          }}
        />
      </Suspense>
    </div>
  );
}

export function DeveloperApiDocumentation() {
  return (
    <section
      className="developer-api-page"
      aria-labelledby="developer-api-title"
    >
      <header className="developer-api-heading">
        <div>
          <p className="eyebrow">Developer</p>
          <h1 id="developer-api-title">API documentation</h1>
          <p>Explore and test the permission-filtered OKF Hub API.</p>
        </div>
        <a
          href="/settings/developer"
          className={buttonVariants({ variant: "outline" })}
        >
          <KeyRound /> Manage API keys
        </a>
      </header>
      <ApiDocumentation />
    </section>
  );
}

export function DeveloperSettings() {
  const [actions, setActions] = useState<Action[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [actionsResponse, keysResponse] = await Promise.all([
      api("/api/v1/actions"),
      api("/api/developer/keys"),
    ]);
    const actionBody = await actionsResponse.json();
    const keyBody = await keysResponse.json();
    if (!actionsResponse.ok || !keysResponse.ok) {
      throw new Error(
        actionBody.error ?? keyBody.error ?? "Developer tools unavailable",
      );
    }
    setActions(actionBody.actions);
    setKeys(keyBody.keys);
  }, []);
  useEffect(() => {
    load().catch((cause) => setError(cause.message));
  }, [load]);

  const openCreate = () => {
    setName("");
    setScopes([]);
    setToken("");
    setCopied(false);
    setError("");
    setDialogOpen(true);
  };
  const toggleScope = (scope: string, checked: boolean) =>
    setScopes((current) =>
      checked
        ? Array.from(new Set([...current, scope]))
        : current.filter((item) => item !== scope)
    );

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const response = await api("/api/developer/keys", {
      method: "POST",
      body: JSON.stringify({ name, scopes }),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setError(body.error ?? "API key creation failed");
      return;
    }
    setToken(body.token);
    await load();
  };

  const revoke = async (id: string) => {
    setError("");
    const response = await api(
      `/api/developer/keys/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "API key revocation failed");
      return;
    }
    await load();
  };

  const copy = async () => {
    await navigator.clipboard.writeText(token);
    setCopied(true);
  };
  const visibleKeys = keys.filter((key) =>
    `${key.name} ${key.prefix} ${key.scopes.join(" ")}`.toLowerCase().includes(
      query.trim().toLowerCase(),
    )
  );

  return (
    <div className="settings-section developer-settings">
      <div className="settings-section-heading">
        <div>
          <p className="eyebrow">Developer</p>
          <h2>Developer API</h2>
          <p>
            Build integrations and agent workflows on the same
            permission-filtered operations used by OKF Hub.
          </p>
        </div>
        <a
          href="/developer/api"
          className={buttonVariants({ variant: "outline" })}
        >
          <BookOpen /> API documentation
        </a>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Create a separate key for every integration so access can be revoked
            independently.
          </CardDescription>
          <CardAction className="developer-key-tools">
            {keys.length > 0 && (
              <div className="developer-key-search">
                <Search />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter keys"
                  aria-label="Filter API keys"
                />
              </div>
            )}
            <Button type="button" onClick={openCreate}>
              <Plus /> Create key
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {visibleKeys.length
            ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Scopes</TableHead>
                    <TableHead>Last used</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleKeys.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell>
                        <strong>{key.name}</strong>
                        <small className="developer-key-prefix">
                          {key.prefix}…
                        </small>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {key.scopes.length} operations
                        </Badge>
                        {key.revokedAt && (
                          <Badge variant="destructive">Revoked</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {key.lastUsedAt
                          ? new Date(key.lastUsedAt).toLocaleDateString()
                          : "Never"}
                      </TableCell>
                      <TableCell className="text-right">
                        {!key.revokedAt && (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Revoke ${key.name}`}
                            onClick={() => void revoke(key.id)}
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
                <KeyRound />
                <h3>No API keys</h3>
                <p>
                  Create a scoped key when an integration is ready to connect.
                </p>
              </div>
            )}
        </CardContent>
      </Card>
      {error && <p className="source-error" role="alert">{error}</p>}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="developer-key-dialog sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Name the integration and grant only the operations it needs. The
              secret is shown once.
            </DialogDescription>
          </DialogHeader>
          {token
            ? (
              <div className="developer-token-result">
                <Alert>
                  <KeyRound />
                  <AlertTitle>Copy this key now</AlertTitle>
                  <AlertDescription>
                    It cannot be recovered after this dialog closes.
                  </AlertDescription>
                </Alert>
                <code>{token}</code>
                <Button type="button" onClick={() => void copy()}>
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Copied" : "Copy key"}
                </Button>
              </div>
            )
            : (
              <form
                className="developer-key-builder"
                onSubmit={(event) => void create(event)}
              >
                <Label>
                  <span>Key name</span>
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={80}
                    placeholder="Slack knowledge sync"
                    required
                  />
                </Label>
                <fieldset>
                  <legend>Allowed operations</legend>
                  <p>
                    Select the smallest useful set. Access is still limited by
                    your OKF permissions.
                  </p>
                  <div className="developer-scope-grid">
                    {actions.map((action) => (
                      <Label className="developer-scope" key={action.name}>
                        <Checkbox
                          checked={scopes.includes(action.name)}
                          onCheckedChange={(checked) =>
                            toggleScope(action.name, checked)}
                        />
                        <span>
                          <strong>{action.title}</strong>
                          <small>{action.name} · {action.mode}</small>
                        </span>
                      </Label>
                    ))}
                  </div>
                </fieldset>
                {error && <p className="source-error" role="alert">{error}</p>}
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={busy || scopes.length === 0}>
                    <KeyRound /> {busy ? "Creating…" : "Create key"}
                  </Button>
                </DialogFooter>
              </form>
            )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
