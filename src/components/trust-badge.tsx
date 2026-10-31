import type { Freshness } from "../lib/governance.ts";
import type { Trust } from "../lib/models.ts";
import { reviewAttention } from "../lib/governance.ts";
import { StatusBadge, statusBadge } from "./status-badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

function Reasoned({ status, reasons }: { status: string; reasons: string[] }) {
  if (!reasons.length) return <StatusBadge status={status} />;
  const { label } = statusBadge(status);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <StatusBadge
            status={status}
            tabIndex={0}
            aria-label={`${label}: ${reasons.join("; ")}`}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipContent>
        {reasons.map((reason) => <div key={reason}>{reason}</div>)}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One status for content problems: stale code or dependencies (`trust`) and a
 * review that is due (`freshness`) both read "Needs attention". A failed source
 * sync stays its own badge.
 */
export function TrustBadge(
  { trust = "current", reason, freshness, reviewDueDate }: {
    trust?: Trust;
    reason?: string;
    freshness?: Freshness;
    reviewDueDate?: string | null;
  },
) {
  const review = freshness && reviewAttention(freshness, reviewDueDate);
  const reasons = [trust === "stale" ? reason : null, review].filter(
    (item): item is string => Boolean(item),
  );
  return (
    <>
      {trust === "sync_failed" && (
        <Reasoned status="sync_failed" reasons={reason ? [reason] : []} />
      )}
      {(trust === "stale" || review) && (
        <Reasoned status="needs_attention" reasons={reasons} />
      )}
    </>
  );
}
