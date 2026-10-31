import {
  Activity,
  Archive,
  Blocks,
  CircleCheck,
  Download,
  Eye,
  FilePlus2,
  FileText,
  Focus,
  GitCompareArrows,
  History,
  Link2,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Presentation,
  RotateCcw,
  Settings2,
  Sparkles,
  TriangleAlert,
  Users,
} from "lucide-react";
import type { Collaborator } from "../../collab-provider.ts";
import type { Trust } from "../../lib/models.ts";
import { TrustBadge } from "../trust-badge.tsx";
import { Button } from "../ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import "./editor-ux.css";

export type DocumentSurface = "document" | "artifacts" | "activity";
export type DocumentMode = "edit" | "read";
export type DocumentWidth = "narrow" | "standard" | "wide";

type DocumentToolbarProps = {
  actionBusy: boolean;
  canEdit: boolean;
  collaborators: Collaborator[];
  commentCount: number;
  exportHref?: string;
  hasPublished: boolean;
  hasUnpublishedChanges: boolean;
  saveState?: "saving" | "saved" | "failed";
  focusMode: boolean;
  mode: DocumentMode;
  revisionCount: number;
  status: "active" | "archived";
  trust?: Trust;
  trustReason?: string;
  surface: DocumentSurface;
  view: "draft" | "published";
  width: DocumentWidth;
  onArchive: () => void;
  onAsk: () => void;
  onComments: () => void;
  onHistory: () => void;
  onModeChange: (mode: DocumentMode) => void;
  onPublish: () => void;
  onReviewChanges: () => void;
  onRetrySave?: () => void;
  onPresent: () => void;
  onReferences: () => void;
  onRestore: () => void;
  onSettings: () => void;
  onSaveAsTemplate?: () => void;
  onSurfaceChange: (surface: DocumentSurface) => void;
  onFocusModeChange: (focus: boolean) => void;
  onViewChange: (view: "draft" | "published") => void;
  onWidthChange: (width: DocumentWidth) => void;
};

export function DocumentToolbar({
  actionBusy,
  canEdit,
  collaborators,
  commentCount,
  exportHref,
  hasPublished,
  hasUnpublishedChanges,
  saveState,
  focusMode,
  mode,
  revisionCount,
  status,
  trust,
  trustReason,
  surface,
  view,
  width,
  onArchive,
  onAsk,
  onComments,
  onHistory,
  onModeChange,
  onPublish,
  onReviewChanges,
  onRetrySave,
  onPresent,
  onReferences,
  onRestore,
  onSettings,
  onSaveAsTemplate,
  onSurfaceChange,
  onFocusModeChange,
  onViewChange,
  onWidthChange,
}: DocumentToolbarProps) {
  return (
    <div className="document-toolbar">
      <Tabs
        className="document-surface-tabs"
        value={surface}
        onValueChange={(value) => onSurfaceChange(value as DocumentSurface)}
      >
        <TabsList className="h-8 p-0.5" aria-label="Document view">
          <TabsTrigger
            value="document"
            className="h-7 gap-1.5 px-2.5 text-xs"
            aria-label="Document"
            title="Document"
          >
            <FileText className="size-3.5" />
            <span className="hidden lg:inline">Document</span>
          </TabsTrigger>
          <TabsTrigger
            value="artifacts"
            className="h-7 gap-1.5 px-2.5 text-xs"
            aria-label="Apps"
            title="Apps"
          >
            <Blocks className="size-3.5" />
            <span className="hidden lg:inline">Apps</span>
          </TabsTrigger>
          <TabsTrigger
            value="activity"
            className="h-7 gap-1.5 px-2.5 text-xs"
            aria-label="Activity"
            title="Activity"
          >
            <Activity className="size-3.5" />
            <span className="hidden lg:inline">Activity</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 gap-1.5 px-2.5 text-xs"
        onClick={onAsk}
        aria-label="Ask OKF"
        title="Ask OKF"
      >
        <Sparkles className="size-3.5" />
        <span className="hidden xl:inline">Ask OKF</span>
      </Button>

      <span
        className="document-collaborators document-presence"
        aria-label={collaborators.length
          ? `${collaborators.length} people in this document, including you`
          : "No one connected to this document"}
        title={collaborators.length
          ? `In this document: ${
            collaborators.map((person) => person.name).join(", ")
          }`
          : "No one connected to this document"}
      >
        <Users className="size-3.5" aria-hidden="true" />
        <span>{collaborators.length}</span>
      </span>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 gap-1.5 px-2 text-xs"
        aria-label={`${commentCount} open comments`}
        title="Comments"
        onClick={onComments}
      >
        <MessageSquare className="size-3.5" />
        {commentCount > 0 && <span>{commentCount}</span>}
      </Button>

      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="References and backlinks"
        title="References and backlinks"
        onClick={onReferences}
      >
        <Link2 />
      </Button>

      <TrustBadge trust={trust} reason={trustReason} />

      {canEdit && status === "active" && (
        <Tabs
          className="document-version-tabs"
          value={view}
          onValueChange={(value) =>
            onViewChange(value as "draft" | "published")}
        >
          <TabsList className="h-8 p-0.5" aria-label="Document version">
            <TabsTrigger
              value="draft"
              title="Edit draft"
              aria-label={hasUnpublishedChanges
                ? "Draft with unpublished changes"
                : "Draft"}
              className="h-7 gap-1 px-2 text-xs"
            >
              Draft
              {hasUnpublishedChanges && (
                <span className="draft-change-dot" aria-hidden="true" />
              )}
            </TabsTrigger>
            <TabsTrigger
              value="published"
              disabled={!hasPublished}
              title={hasPublished
                ? "View published document"
                : "Publish a first version to make it available to readers"}
              className="h-7 px-2 text-xs"
            >
              Published
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {canEdit && status === "active" && view === "draft" && saveState && (
        <div
          className="document-save-status"
          data-state={saveState}
          role="status"
          aria-live="polite"
        >
          {saveState === "saving"
            ? (
              <LoaderCircle
                className="size-3.5 animate-spin"
                aria-hidden="true"
              />
            )
            : saveState === "failed"
            ? <TriangleAlert className="size-3.5" aria-hidden="true" />
            : <CircleCheck className="size-3.5" aria-hidden="true" />}
          <span>
            {saveState === "saving"
              ? "Saving…"
              : saveState === "failed"
              ? "Save failed"
              : "Saved"}
          </span>
          {saveState === "failed" && onRetrySave && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              aria-label="Retry saving document"
              onClick={onRetrySave}
            >
              Retry
            </Button>
          )}
        </div>
      )}

      {canEdit && status === "active" && hasUnpublishedChanges && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 px-2 text-xs"
          aria-label="Review unpublished changes"
          title="Review changes before publishing"
          onClick={onReviewChanges}
        >
          <GitCompareArrows className="size-3.5" />
          <span className="hidden sm:inline">Review changes</span>
        </Button>
      )}

      {canEdit && status === "active" && view === "draft" && (
        <Button
          aria-label={actionBusy ? "Publishing" : "Publish"}
          className="h-8 px-3 text-xs"
          type="button"
          onClick={onPublish}
          disabled={actionBusy || (hasPublished && !hasUnpublishedChanges)}
          title={hasPublished && !hasUnpublishedChanges
            ? "No unpublished changes"
            : "Publish this draft"}
        >
          <FilePlus2 className="size-3.5" />
          <span className="hidden lg:inline">
            {actionBusy ? "Publishing…" : "Publish"}
          </span>
        </Button>
      )}

      {canEdit && status === "archived" && (
        <Button
          className="h-8 px-3 text-xs"
          type="button"
          disabled={actionBusy}
          onClick={onRestore}
        >
          <RotateCcw className="size-3.5" />
          Restore concept
        </Button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Document actions"
              title="Document actions"
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onPresent}>
            <Presentation /> Present
          </DropdownMenuItem>
          {canEdit && view === "draft" && (
            <DropdownMenuItem
              onClick={() => onModeChange(mode === "edit" ? "read" : "edit")}
            >
              {mode === "edit" ? <Eye /> : <Pencil />}
              {mode === "edit" ? "Reading view" : "Editing view"}
            </DropdownMenuItem>
          )}
          <DropdownMenuCheckboxItem
            checked={focusMode}
            onCheckedChange={onFocusModeChange}
          >
            <Focus /> Focus mode
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={width}
            onValueChange={(value) => onWidthChange(value as DocumentWidth)}
          >
            <DropdownMenuRadioItem value="narrow">
              Narrow
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="standard">
              Standard
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="wide">Wide</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          {exportHref && (
            <DropdownMenuItem>
              <a href={exportHref} className="flex w-full items-center gap-2">
                <Download /> Download OKF
              </a>
            </DropdownMenuItem>
          )}
          {canEdit && (
            <>
              <DropdownMenuItem onClick={onHistory}>
                <History /> History ({revisionCount})
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onSettings}>
                <Settings2 /> Settings
              </DropdownMenuItem>
              {status === "active" && onSaveAsTemplate && (
                <DropdownMenuItem onClick={onSaveAsTemplate}>
                  <FilePlus2 /> Save as template
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {status === "active"
                ? (
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={onArchive}
                  >
                    <Archive /> Archive
                  </DropdownMenuItem>
                )
                : (
                  <DropdownMenuItem onClick={onRestore}>
                    <RotateCcw /> Restore concept
                  </DropdownMenuItem>
                )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
