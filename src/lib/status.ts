type Variant = "success" | "warning" | "destructive" | "secondary";

// One vocabulary for machine states shown across sources, syncs, automation,
// trust and artifacts: sentence-case label plus a tone that means the same
// thing everywhere (green healthy, amber needs a look, red broken).
const STATUSES: Record<string, [label: string, variant: Variant]> = {
  current: ["Current", "success"],
  syncing: ["Syncing", "secondary"],
  sync_failed: ["Sync failed", "destructive"],
  needs_attention: ["Needs attention", "warning"],
  running: ["Running", "secondary"],
  succeeded: ["Succeeded", "success"],
  partial: ["Partial", "warning"],
  failed: ["Failed", "destructive"],
  live: ["Live", "success"],
  draft: ["Draft", "secondary"],
  changes_pending: ["Changes pending", "warning"],
};

export function statusBadge(status: string) {
  const [label, variant] = STATUSES[status] ??
    [
      status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " "),
      "secondary",
    ];
  return { label, variant };
}
