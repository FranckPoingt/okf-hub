import { useEffect, useState } from "react";
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

export function SpaceManagers({ spaceId, members }: {
  spaceId: string;
  members: NonNullable<Bootstrap["members"]>;
}) {
  const [managers, setManagers] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const path = `/api/spaces/${encodeURIComponent(spaceId)}/managers`;
  useEffect(() => {
    let active = true;
    setBusy(true);
    api(path).then(async (response) => {
      if (!response.ok) throw new Error("Could not load managers");
      const result = await response.json();
      if (active) setManagers(result.managers);
    }).catch((cause) => {
      if (active) setError(cause.message);
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => {
      active = false;
    };
  }, [path]);

  async function update(userId: string, enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      const response = await api(`${path}/${encodeURIComponent(userId)}`, {
        method: enabled ? "PUT" : "DELETE",
      });
      if (!response.ok) throw new Error("Could not update managers");
      setManagers((current) =>
        enabled ? [...current, userId] : current.filter((id) => id !== userId)
      );
      setSelected("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update managers",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-3">
      <h4 className="font-medium">Managers</h4>
      <p className="text-sm text-muted-foreground">
        Managers can activate Apps in this space. Workspace owners can always
        activate Apps.
      </p>
      {managers.map((id) => (
        <div key={id} className="flex items-center justify-between gap-2">
          <span>
            {members.find((member) =>
              member.id === id
            )?.name ?? id}
          </span>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void update(id, false)}
          >
            Remove
          </Button>
        </div>
      ))}
      <Label htmlFor={`manager-${spaceId}`}>Add manager</Label>
      <div className="flex gap-2">
        <Select
          value={selected}
          onValueChange={(value) => setSelected(value ?? "")}
        >
          <SelectTrigger id={`manager-${spaceId}`}>
            <SelectValue placeholder="Choose a member" />
          </SelectTrigger>
          <SelectContent>
            {members.filter((member) => !managers.includes(member.id)).map((
              member,
            ) => (
              <SelectItem key={member.id} value={member.id}>
                {member.name} ({member.email})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          disabled={busy || !selected}
          onClick={() => void update(selected, true)}
        >
          Add
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
