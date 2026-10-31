import type { Trust } from "../lib/models.ts";
import { StatusBadge, statusBadge } from "./status-badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

export function TrustBadge(
  { trust = "current", reason }: { trust?: Trust; reason?: string },
) {
  if (trust === "current") return null;
  if (!reason) return <StatusBadge status={trust} />;
  const { label } = statusBadge(trust);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <StatusBadge
            status={trust}
            tabIndex={0}
            aria-label={`${label}: ${reason}`}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
