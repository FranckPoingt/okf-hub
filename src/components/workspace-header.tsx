import type { ReactNode } from "react";
import { Search } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./ui/breadcrumb.tsx";
import { SidebarTrigger } from "./ui/sidebar.tsx";
import { Button } from "./ui/button.tsx";
import "./editor/editor-ux.css";

type WorkspaceHeaderProps = {
  detail: string;
  section: string;
  status: string;
  statusTone: "connecting" | "offline" | "online";
  title: string;
  onSearch: () => void;
  actions?: ReactNode;
};

export function WorkspaceHeader({
  detail,
  section,
  status,
  statusTone,
  title,
  onSearch,
  actions,
}: WorkspaceHeaderProps) {
  const showConnection = status === "offline" || status === "syncing";
  const showStatus = status !== "online";
  return (
    <header
      className="workspace-header editor-workspace-header"
      data-has-actions={Boolean(actions)}
    >
      <SidebarTrigger aria-label="Toggle navigation" />
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap">
          <BreadcrumbItem className="hidden min-w-0 sm:inline-flex">
            <span className="max-w-48 truncate">{section}</span>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="hidden sm:list-item" />
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="block max-w-[48vw] truncate font-medium">
              {title}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-muted-foreground"
        type="button"
        aria-label="Search company knowledge"
        title="Search company knowledge (⌘K)"
        onClick={onSearch}
      >
        <Search />
        <span className="hidden xl:inline">Search</span>
        <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] 2xl:inline">
          ⌘K
        </kbd>
      </Button>
      {showStatus || detail
        ? (
          <div className="workspace-header-status" aria-live="polite">
            {showConnection
              ? (
                <span
                  className={`status-dot ${statusTone}`}
                  aria-hidden="true"
                />
              )
              : null}
            {showStatus ? <span className="capitalize">{status}</span> : null}
            {detail
              ? (
                <span className="text-muted-foreground">
                  {detail}
                </span>
              )
              : null}
          </div>
        )
        : null}
      {actions}
    </header>
  );
}
