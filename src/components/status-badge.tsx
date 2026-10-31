import type { ComponentProps } from "react";
import { statusBadge } from "../lib/status.ts";
import { Badge } from "./ui/badge.tsx";

export { statusBadge };

export function StatusBadge(
  { status, children, ...props }:
    & { status: string }
    & Omit<ComponentProps<typeof Badge>, "variant">,
) {
  const { label, variant } = statusBadge(status);
  return <Badge variant={variant} {...props}>{children ?? label}</Badge>;
}
