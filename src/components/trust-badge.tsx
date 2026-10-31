import type { Trust } from "../lib/models.ts";
import { Badge } from "./ui/badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

export function TrustBadge(
  { trust = "current", reason }: { trust?: Trust; reason?: string },
) {
  if (trust === "current") return null;
  const label = trust.replace("_", " ");
  if (!reason) return <Badge variant="destructive">{label}</Badge>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="destructive"
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
