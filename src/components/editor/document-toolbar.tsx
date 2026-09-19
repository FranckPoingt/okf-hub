import {
  Activity,
  Archive,
  Blocks,
  Download,
  Eye,
  FilePlus2,
  FileText,
  Focus,
  History,
  Link2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Presentation,
  RotateCcw,
  Settings2,
  Sparkles,
  Users,
} from "lucide-react";
import type { Collaborator } from "../../collab-provider.ts";
import { Badge } from "../ui/badge.tsx";
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
  focusMode: boolean;
  mode: DocumentMode;
  revisionCount: number;
  status: "active" | "archived";
  surface: DocumentSurface;
  view: "draft" | "published";
  width: DocumentWidth;
  onArchive: () => void;
  onAsk: () => void;
  onComments: () => void;
  onHistory: () => void;
  onModeChange: (mode: DocumentMode) => void;
  onPublish: () => void;
  onPresent: () => void;
  onReferences: () => void;
  onRestore: () => void;
  onSettings: () => void;
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
  focusMode,
  mode,
  revisionCount,
  status,
  surface,
  view,
  width,
  onArchive,
  onAsk,
  onComments,
  onHistory,
  onModeChange,
  onPublish,
  onPresent,
  onReferences,
  onRestore,
  onSettings,
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
      >
        <Sparkles className="size-3.5" />
        <span className="hidden xl:inline">Ask OKF</span>
      </Button>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="document-collaborators h-8 gap-1.5 px-2 text-xs text-muted-foreground"
        aria-label={`${collaborators.length} collaborators online`}
        title={collaborators.length
          ? collaborators.map((person) => person.name).join(", ")
          : "No collaborators online"}
      >
        <Users className="size-3.5" />
        <span>{collaborators.length}</span>
      </Button>

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

      {canEdit && status === "active" && (
        <Badge
          variant={view === "published" ? "default" : "secondary"}
          className="h-6 rounded-md px-2 text-[11px] font-medium"
        >
          {view === "published" ? "Published" : "Draft"}
        </Badge>
      )}

      {canEdit && status === "active" && view === "published" &&
        hasPublished && (
        <Button
          className="h-8 px-2.5 text-xs"
          type="button"
          variant="outline"
          onClick={() => onViewChange("draft")}
        >
          <Pencil className="size-3.5" />
          Edit draft
        </Button>
      )}

      {canEdit && status === "active" && view === "draft" && (
        <Button
          aria-label={actionBusy ? "Publishing" : "Publish"}
          className="h-8 px-3 text-xs"
          type="button"
          onClick={onPublish}
          disabled={actionBusy}
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
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onPresent}>
            <Presentation /> Present
          </DropdownMenuItem>
          {canEdit && (
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
