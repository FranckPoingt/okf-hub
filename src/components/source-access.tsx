import { useEffect, useState } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { api } from "../lib/api.ts";
import type { Bootstrap } from "../lib/models.ts";
import { Button } from "./ui/button.tsx";
import { Label } from "./ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";

type Grant = {
  type: "user" | "group";
  id: string;
  role: "viewer" | "editor";
};
type Access = { mode: "workspace" | "restricted"; grants: Grant[] };

export function SourceAccess({ sourceId, members, groups }: {
  sourceId: string;
  members: NonNullable<Bootstrap["members"]>;
  groups: NonNullable<Bootstrap["groups"]>;
}) {
  const [access, setAccess] = useState<Access | null>(null);
  const [selected, setSelected] = useState("");
  const [role, setRole] = useState<Grant["role"]>("viewer");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const path = `/api/sources/${encodeURIComponent(sourceId)}/access`;
  useEffect(() => {
    let active = true;
    setBusy(true);
    api(path).then(async (response) => {
      if (!response.ok) throw new Error("Could not load access");
      const result = await response.json();
      if (active) setAccess(result);
    }).catch((cause) => {
      if (active) setError(cause.message);
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => {
      active = false;
    };
  }, [path]);

  async function save(next: Access) {
    setBusy(true);
    setError("");
    try {
      const response = await api(path, {
        method: "PUT",
        body: JSON.stringify(next),
      });
      if (!response.ok) {
        throw new Error(
          (await response.json().catch(() => ({}))).error ??
            "Could not update access",
        );
      }
      setAccess(await response.json());
      setSelected("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update access",
      );
    } finally {
      setBusy(false);
    }
  }

  const label = (grant: Grant) =>
    grant.type === "user"
      ? members.find((member) => member.id === grant.id)?.name ?? grant.id
      : `${
        groups.find((group) => group.id === grant.id)?.name ?? grant.id
      } (group)`;
  const granted = new Set(
    access?.grants.map((grant) => `${grant.type}:${grant.id}`),
  );
  // Owners always keep access, so they are not offered as grants.
  const candidates = [
    ...groups.map((group) => ({
      value: `group:${group.id}`,
      label: `${group.name} (group)`,
    })),
    ...members.filter((member) => member.access !== "owner").map((member) => ({
      value: `user:${member.id}`,
      label: `${member.name} (${member.email})`,
    })),
  ].filter((item) => !granted.has(item.value));

  return (
    <details className="source-settings">
      <summary>
        <span>
          <ShieldCheck /> Access
        </span>
        <ChevronDown className="source-details-chevron" />
      </summary>
      <section className="grid gap-3">
        <Label htmlFor={`source-access-${sourceId}`}>Who can see this</Label>
        <Select
          value={access?.mode ?? "workspace"}
          onValueChange={(value) =>
            access && value && value !== access.mode &&
            void save({
              mode: value as Access["mode"],
              grants: value === "workspace" ? [] : access.grants,
            })}
          disabled={busy || !access}
        >
          <SelectTrigger id={`source-access-${sourceId}`}>
            <SelectValue>
              {(value) =>
                value === "restricted"
                  ? "Selected members and groups"
                  : "Everyone in the workspace"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="workspace">Everyone in the workspace</SelectItem>
            <SelectItem value="restricted">
              Selected members and groups
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">
          {access?.mode === "restricted"
            ? "Only workspace owners and the people below can find, read, or ask about this source. Editors can also suggest changes and draft OKF."
            : "Every workspace member can read this source. Workspace editors can suggest changes and draft OKF."}
        </p>
        {access?.mode === "restricted" && (
          <>
            {access.grants.map((grant) => (
              <div
                key={`${grant.type}:${grant.id}`}
                className="flex items-center justify-between gap-2"
              >
                <span>
                  {label(grant)} ·{" "}
                  {grant.role === "editor" ? "Editor" : "Viewer"}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void save({
                      ...access,
                      grants: access.grants.filter((item) => item !== grant),
                    })}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Label htmlFor={`source-grant-${sourceId}`}>
              Add member or group
            </Label>
            <div className="flex gap-2">
              <Select
                value={selected}
                onValueChange={(value) => setSelected(value ?? "")}
              >
                <SelectTrigger id={`source-grant-${sourceId}`}>
                  <SelectValue>
                    {(value) =>
                      candidates.find((item) => item.value === value)?.label ??
                        "Choose a member or group"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={role}
                onValueChange={(value) =>
                  setRole((value ?? "viewer") as Grant["role"])}
              >
                <SelectTrigger aria-label="Role">
                  <SelectValue>
                    {(value) => value === "editor" ? "Editor" : "Viewer"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="editor">Editor</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                disabled={busy || !selected}
                onClick={() => {
                  const split = selected.indexOf(":");
                  void save({
                    ...access,
                    grants: [...access.grants, {
                      type: selected.slice(0, split) as Grant["type"],
                      id: selected.slice(split + 1),
                      role,
                    }],
                  });
                }}
              >
                Add
              </Button>
            </div>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    </details>
  );
}
