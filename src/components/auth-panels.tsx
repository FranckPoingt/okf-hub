import { type FormEvent, useEffect, useState } from "react";
import { Building2, Plus, ShieldCheck, UserPlus, Users } from "lucide-react";
import { api } from "../lib/api.ts";
import type { AuditEvent, Invitation } from "../lib/models.ts";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
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

export function AuthScreen(
  { signupAllowed, ssoProviders, onAuthenticated }: {
    signupAllowed: boolean;
    ssoProviders: {
      providerId: string;
      name: string;
      type: "oidc" | "saml";
    }[];
    onAuthenticated: () => Promise<void>;
  },
) {
  const invitationId = new URLSearchParams(globalThis.location.search).get(
    "invitation",
  );
  const invited = Boolean(invitationId);
  const canSignUp = signupAllowed || invited;
  const [mode, setMode] = useState<"sign-in" | "sign-up">(
    canSignUp ? "sign-up" : "sign-in",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const signInWithSSO = async (providerId: string) => {
    setBusy(true);
    setError("");
    const callbackURL =
      `${globalThis.location.origin}${globalThis.location.pathname}${globalThis.location.search}`;
    const response = await api("/api/auth/sign-in/sso", {
      method: "POST",
      body: JSON.stringify({
        providerId,
        callbackURL,
        errorCallbackURL: callbackURL,
        newUserCallbackURL: callbackURL,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || typeof result.url !== "string") {
      setError(result.message ?? result.error ?? "Single sign-on failed");
      setBusy(false);
      return;
    }
    globalThis.location.assign(result.url);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form);
    if (mode === "sign-in") delete body.name;
    if (mode === "sign-up" && invitationId) body.invitationId = invitationId;
    const response = await api(`/api/auth/${mode}/email`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      setError(result.message ?? result.error ?? "Authentication failed");
      setBusy(false);
      return;
    }
    await onAuthenticated();
  };

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <a className="brand" href="/" aria-label="OKF Hub home">
          <span>O</span> OKF Hub
        </a>
        <p className="eyebrow">
          {invited ? "You have been invited" : "Customer-controlled knowledge"}
        </p>
        <h1>{mode === "sign-up" ? "Create your account" : "Welcome back"}</h1>
        <p>
          {invited
            ? "Use the invited email address, then accept your access."
            : mode === "sign-up"
            ? "Create your account first. You’ll choose a workspace in the next step."
            : "Sign in to your organisation’s private knowledge hub."}
        </p>
        {ssoProviders.length > 0 && (
          <div className="auth-sso">
            {ssoProviders.map((provider) => (
              <Button
                key={provider.providerId}
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => void signInWithSSO(provider.providerId)}
              >
                <ShieldCheck /> Continue with {provider.name}
              </Button>
            ))}
            <span>or use email</span>
          </div>
        )}
        <form onSubmit={(event) => void submit(event)}>
          {mode === "sign-up" && (
            <label>
              Name<Input name="name" autoComplete="name" required />
            </label>
          )}
          <label>
            Email<Input
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </label>
          <label>
            Password<Input
              name="password"
              type="password"
              minLength={8}
              autoComplete={mode === "sign-up"
                ? "new-password"
                : "current-password"}
              required
            />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <Button
            variant="default"
            className="primary"
            type="submit"
            disabled={busy}
          >
            {busy
              ? "Working…"
              : mode === "sign-up"
              ? "Create account"
              : "Sign in"}
          </Button>
        </form>
        {canSignUp && (
          <Button
            className="text-button"
            type="button"
            onClick={() => setMode(mode === "sign-up" ? "sign-in" : "sign-up")}
          >
            {mode === "sign-up"
              ? "Already have an account? Sign in"
              : "Need an account? Sign up"}
          </Button>
        )}
      </section>
    </main>
  );
}

export function WorkspaceOnboarding(
  { onComplete, onSignOut }: {
    onComplete: () => Promise<void>;
    onSignOut: () => void;
  },
) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await api("/api/setup", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        tagline: form.get("tagline"),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(result.error ?? "Workspace creation failed");
      setBusy(false);
      return;
    }
    await onComplete();
  };

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <a className="brand" href="/" aria-label="OKF Hub home">
          <span>O</span> OKF Hub
        </a>
        <p className="eyebrow">Account created</p>
        <h1>Set up your workspace</h1>
        <p>
          Your account is ready. A workspace is only created when you finish
          this step.
        </p>
        <form onSubmit={(event) => void submit(event)}>
          <Label>
            <span>Workspace name</span>
            <Input
              name="name"
              maxLength={60}
              placeholder="Acme knowledge"
              autoFocus
              required
            />
          </Label>
          <Label>
            <span>
              Tagline <small>optional</small>
            </span>
            <Input
              name="tagline"
              maxLength={100}
              placeholder="Company knowledge"
            />
          </Label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <Button
            variant="default"
            className="primary"
            type="submit"
            disabled={busy}
          >
            <Building2 /> {busy ? "Creating…" : "Create workspace"}
          </Button>
        </form>
        <Button
          variant="link"
          className="text-button"
          type="button"
          onClick={onSignOut}
        >
          Sign out
        </Button>
      </section>
    </main>
  );
}

export function AccessGate(
  { invited, onAccepted, onSignOut }: {
    invited: boolean;
    onAccepted: () => Promise<void>;
    onSignOut: () => void;
  },
) {
  const [error, setError] = useState("");
  const accept = async () => {
    const invitationId = new URLSearchParams(globalThis.location.search).get(
      "invitation",
    );
    const response = await api("/api/invitations/accept", {
      method: "POST",
      body: JSON.stringify({ invitationId }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      setError(result.error ?? "Could not accept invitation");
      return;
    }
    globalThis.history.replaceState({}, "", globalThis.location.pathname);
    await onAccepted();
  };
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <a className="brand" href="/" aria-label="OKF Hub home">
          <span>O</span> OKF Hub
        </a>
        <p className="eyebrow">Organisation access</p>
        <h1>{invited ? "Accept your invitation" : "Access not granted"}</h1>
        <p>
          {invited
            ? "This invitation adds you to the group that can view or edit hub knowledge spaces."
            : "Ask the organisation owner for an editor or viewer invitation."}
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
        {invited && (
          <Button
            className="primary"
            type="button"
            onClick={() => void accept()}
          >
            Accept invitation
          </Button>
        )}
        <Button
          variant="link"
          className="text-button"
          type="button"
          onClick={onSignOut}
        >
          Sign out
        </Button>
      </section>
    </main>
  );
}

type Member = {
  id: string;
  name: string;
  email: string;
  access: "owner" | "editor" | "viewer" | "member";
};
type AccessGroup = {
  id: string;
  name: string;
  access: "editor" | "viewer";
  memberCount: number;
};

export function AccessPanel({
  invitations,
  members = [],
  groups = [],
}: {
  invitations: Invitation[];
  members?: Member[];
  groups?: AccessGroup[];
}) {
  const [email, setEmail] = useState("");
  const [inviteTarget, setInviteTarget] = useState("viewer");
  const [groupAccess, setGroupAccess] = useState<"editor" | "viewer">(
    "viewer",
  );
  const [items, setItems] = useState(invitations);
  const [groupItems, setGroupItems] = useState(groups);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [error, setError] = useState("");

  const loadAudit = () =>
    api("/api/audit").then((response) => response.json()).then(setAudit);
  useEffect(() => {
    void loadAudit();
  }, []);

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const response = await api("/api/invitations", {
      method: "POST",
      body: JSON.stringify(
        inviteTarget.startsWith("group:")
          ? { email, teamId: inviteTarget.slice(6) }
          : { email, access: inviteTarget },
      ),
    });
    const result = await response.json();
    if (!response.ok) return setError(result.error ?? "Invitation failed");
    setItems([{
      invitationId: result.id,
      email,
      access: inviteTarget.startsWith("group:")
        ? groupItems.find((group) => group.id === inviteTarget.slice(6))
          ?.access ?? "viewer"
        : inviteTarget as "editor" | "viewer",
      url: result.url,
      status: "pending",
    }, ...items]);
    setEmail("");
    void loadAudit();
  };
  const createGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    const form = event.currentTarget;
    const fields = new FormData(form);
    const response = await api("/api/groups", {
      method: "POST",
      body: JSON.stringify({
        name: fields.get("name"),
        access: fields.get("access"),
      }),
    });
    const result = await response.json();
    if (!response.ok) return setError(result.error ?? "Group creation failed");
    setGroupItems((current) => [...current, result]);
    form.reset();
    void loadAudit();
  };

  return (
    <section className="access-settings" aria-labelledby="access-heading">
      <div className="settings-section-heading">
        <div>
          <p className="eyebrow">Access</p>
          <h2 id="access-heading">Members and groups</h2>
          <p>Invite people directly or reuse access through optional groups.</p>
        </div>
      </div>
      <Card>
        <CardHeader>
          <UserPlus />
          <CardTitle>Invite a member</CardTitle>
          <CardDescription>
            Choose direct access, or assign an optional group.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="member-invite-form"
            onSubmit={(event) => void invite(event)}
          >
            <Label>
              <span>Email</span>
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </Label>
            <Label>
              <span>Access</span>
              <Select
                value={inviteTarget}
                onValueChange={(value) => setInviteTarget(value ?? "viewer")}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {inviteTarget === "editor"
                      ? "Editor"
                      : inviteTarget === "viewer"
                      ? "Viewer"
                      : groupItems.find((group) =>
                        `group:${group.id}` === inviteTarget
                      )?.name ?? "Viewer"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Direct access</SelectLabel>
                    <SelectItem value="viewer">Viewer</SelectItem>
                    <SelectItem value="editor">Editor</SelectItem>
                  </SelectGroup>
                  {groupItems.length > 0 && <SelectSeparator />}
                  {groupItems.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Groups</SelectLabel>
                      {groupItems.map((group) => (
                        <SelectItem
                          key={group.id}
                          value={`group:${group.id}`}
                        >
                          {group.name} · {group.access}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
            </Label>
            <Button type="submit">
              Create invite link
            </Button>
          </form>
        </CardContent>
      </Card>
      {error && <p className="form-error" role="alert">{error}</p>}
      <Card>
        <CardHeader>
          <Users />
          <CardTitle>Members</CardTitle>
          <CardDescription>
            {members.length} {members.length === 1 ? "person" : "people"}{" "}
            in this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Access</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell>
                    <strong>{member.name}</strong>
                    <small className="member-email">{member.email}</small>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{member.access}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <ShieldCheck />
          <CardTitle>Groups</CardTitle>
          <CardDescription>
            Groups apply one permission level consistently.
          </CardDescription>
        </CardHeader>
        <CardContent className="group-settings">
          <form onSubmit={(event) => void createGroup(event)}>
            <Label>
              <span>Name</span>
              <Input name="name" placeholder="People operations" required />
            </Label>
            <Label>
              <span>Permission</span>
              <input type="hidden" name="access" value={groupAccess} />
              <Select
                value={groupAccess}
                onValueChange={(value) =>
                  setGroupAccess(value as "editor" | "viewer")}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {groupAccess === "editor" ? "Editor" : "Viewer"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="editor">Editor</SelectItem>
                </SelectContent>
              </Select>
            </Label>
            <Button type="submit">
              <Plus /> Create group
            </Button>
          </form>
          <div className="group-list">
            {groupItems.length
              ? groupItems.map((group) => (
                <div key={group.id}>
                  <strong>{group.name}</strong>
                  <span>{group.memberCount} members</span>
                  <Badge variant="outline">{group.access}</Badge>
                </div>
              ))
              : (
                <p className="settings-inline-empty">
                  Groups are optional. Create one when several people need the
                  same access.
                </p>
              )}
          </div>
        </CardContent>
      </Card>
      {items.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pending invitations</CardTitle>
          </CardHeader>
          <CardContent className="invite-list">
            {items.map((item) => (
              <div key={item.invitationId}>
                <strong>{item.email}</strong>
                <span>{item.access} · {item.status}</span>
                <Input
                  aria-label={`Invitation link for ${item.email}`}
                  readOnly
                  value={item.url}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <details className="permission-audit">
        <summary>Permission audit</summary>
        <div className="audit-list">
          {audit.map((event) => (
            <p key={`${event.occurredAt}-${event.target}`}>
              <time>{new Date(event.occurredAt).toLocaleString()}</time>
              <strong>{event.action}</strong>
              <span>{event.target}</span>
            </p>
          ))}
        </div>
      </details>
    </section>
  );
}
