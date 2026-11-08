import {
  Archive,
  Blocks,
  ChevronDown,
  ChevronRight,
  Code2,
  Database,
  FileText,
  Home,
  Lock,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  Plus,
  Settings,
  Sun,
  Unlock,
  Users,
} from "lucide-react";
import { type DragEvent, useState } from "react";
import { Avatar, AvatarFallback } from "./ui/avatar.tsx";
import { SpaceIcon } from "./space-icon.tsx";
import { setTheme, type ThemeChoice, useTheme } from "../lib/theme.ts";
import {
  folderSize,
  type ImportFolder,
  importTree,
} from "../lib/import-tree.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "./ui/sidebar.tsx";

type NavigationView =
  | "home"
  | "search"
  | "artifacts"
  | "space_artifacts"
  | "sources"
  | "developer"
  | "space"
  | "create"
  | "concept"
  | "imported";

type SidebarSpace = { id: string; name: string; icon: string; count: number };
type SidebarConcept = {
  id: string;
  spaceId: string;
  parentId: string | null;
  sortOrder: number;
  title: string;
  type?: string;
  status: "active" | "archived";
  lockedAt: string | null;
  lockedBy: string | null;
};
type SidebarImport = {
  id: string;
  sourceId: string;
  path: string;
  title: string;
};
// One indent step for every nested tree: documents, imported folders and files.
const NESTED_TREE =
  "ml-3 w-[calc(100%-0.75rem)] border-l border-sidebar-border/80 pl-1";

type SidebarSource = {
  id: string;
  name: string;
  count: number;
  kind: "git" | "storage" | "notion";
};

type AppSidebarProps = {
  access?: "owner" | "editor" | "viewer" | "none";
  activeImportId?: string;
  activeView: NavigationView;
  activeSpaceId?: string;
  canEdit: boolean;
  concepts: SidebarConcept[];
  currentConceptId?: string;
  imports: SidebarImport[];
  sources: SidebarSource[];
  spaces: SidebarSpace[];
  user: { email: string; name: string };
  workspace: { name: string; tagline: string; logo: string };
  onCreate: () => void;
  onCreateFromTemplate: () => void;
  onCreateArtifact: (spaceId?: string) => void;
  onCreateDocument: (spaceId?: string, parentId?: string) => void;
  onCreateSpace: () => void;
  onArchiveDocument: (concept: SidebarConcept) => void;
  onToggleDocumentLock: (concept: SidebarConcept) => void;
  onMoveDocument: (
    concept: SidebarConcept,
    destination: { spaceId: string; parentId: string | null; index: number },
  ) => void;
  onManageAccess: () => void;
  onOpenArtifacts: () => void;
  onOpenDeveloper: () => void;
  onOpenConcept: (id: string) => void;
  onOpenHome: () => void;
  onOpenImported: (sourceId: string, path: string) => void;
  onOpenSpace: (id: string) => void;
  onOpenSources: () => void;
  onSignOut: () => void;
};

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0])
    .join("").toUpperCase();

export function AppSidebar({
  access,
  activeImportId,
  activeView,
  activeSpaceId,
  canEdit,
  concepts,
  currentConceptId,
  imports,
  sources,
  spaces,
  user,
  workspace,
  onCreate,
  onCreateFromTemplate,
  onCreateArtifact,
  onCreateDocument,
  onCreateSpace,
  onArchiveDocument,
  onToggleDocumentLock,
  onMoveDocument,
  onManageAccess,
  onOpenArtifacts,
  onOpenDeveloper,
  onOpenConcept,
  onOpenHome,
  onOpenImported,
  onOpenSpace,
  onOpenSources,
  onSignOut,
}: AppSidebarProps) {
  const { state, isMobile } = useSidebar();
  const theme = useTheme();
  const iconOnly = !isMobile && state === "collapsed";
  const [collapsedSpaces, setCollapsedSpaces] = useState<Set<string>>(
    () => new Set(),
  );
  const [collapsedDocuments, setCollapsedDocuments] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedSources, setExpandedSources] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedImportFolders, setExpandedImportFolders] = useState<
    Set<string>
  >(() => new Set());
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<
    {
      id: string;
      position: "before" | "inside" | "after";
    } | null
  >(null);
  const toggleSpace = (spaceId: string) =>
    setCollapsedSpaces((current) => {
      const next = new Set(current);
      next.has(spaceId) ? next.delete(spaceId) : next.add(spaceId);
      return next;
    });
  const conceptIds = new Set(concepts.map((concept) => concept.id));
  const toggleDocument = (id: string) =>
    setCollapsedDocuments((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const dragPosition = (event: DragEvent) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const y = (event.clientY - bounds.top) / bounds.height;
    return y < 0.25 ? "before" : y > 0.75 ? "after" : "inside";
  };
  const dropOnDocument = (event: DragEvent, target: SidebarConcept) => {
    event.preventDefault();
    const source = concepts.find((item) => item.id === draggedId);
    if (!source || source.id === target.id) return;
    const position = dragPosition(event);
    const parentId = position === "inside" ? target.id : target.parentId;
    const siblings = concepts.filter((item) =>
      item.spaceId === target.spaceId && item.parentId === parentId &&
      item.id !== source.id
    );
    const targetIndex = position === "inside"
      ? siblings.length
      : Math.max(0, siblings.findIndex((item) => item.id === target.id)) +
        (position === "after" ? 1 : 0);
    onMoveDocument(source, {
      spaceId: target.spaceId,
      parentId,
      index: targetIndex,
    });
    setDraggedId(null);
    setDropTarget(null);
  };
  const renderConcepts = (
    spaceId: string,
    parentId: string | null,
  ): React.ReactNode =>
    concepts.filter((concept) =>
      concept.spaceId === spaceId &&
      (concept.parentId === parentId ||
        (parentId === null && concept.parentId &&
          !conceptIds.has(concept.parentId)))
    ).map((concept) => {
      const hasChildren = concepts.some((item) =>
        item.spaceId === spaceId && item.parentId === concept.id
      );
      const collapsed = collapsedDocuments.has(concept.id);
      return (
        <SidebarMenuItem
          key={concept.id}
          draggable={canEdit && concept.status === "active"}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", concept.id);
            setDraggedId(concept.id);
          }}
          onDragEnd={() => {
            setDraggedId(null);
            setDropTarget(null);
          }}
          onDragOver={(event) => {
            if (!draggedId || draggedId === concept.id) return;
            event.preventDefault();
            setDropTarget({
              id: concept.id,
              position: dragPosition(event),
            });
          }}
          onDrop={(event) => dropOnDocument(event, concept)}
          className={dropTarget?.id === concept.id
            ? dropTarget.position === "inside"
              ? "rounded-md bg-sidebar-accent ring-1 ring-sidebar-ring"
              : dropTarget.position === "before"
              ? "border-t-2 border-sidebar-primary"
              : "border-b-2 border-sidebar-primary"
            : undefined}
        >
          {hasChildren && (
            <button
              type="button"
              className="absolute top-1.5 left-0.5 z-10 flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent"
              aria-label={`${
                collapsed ? "Expand" : "Collapse"
              } ${concept.title}`}
              aria-expanded={!collapsed}
              onClick={() => toggleDocument(concept.id)}
            >
              {collapsed
                ? <ChevronRight className="size-3.5" />
                : <ChevronDown className="size-3.5" />}
            </button>
          )}
          <SidebarMenuButton
            type="button"
            size="sm"
            tooltip={concept.title}
            isActive={activeView === "concept" &&
              currentConceptId === concept.id}
            onClick={() => onOpenConcept(concept.id)}
            className="pl-6"
          >
            {concept.status === "archived"
              ? <Archive />
              : concept.lockedAt
              ? <Lock />
              : concept.type?.toLocaleLowerCase() === "artifact"
              ? <Blocks />
              : <FileText />}
            <span>{concept.title}</span>
          </SidebarMenuButton>
          {canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuAction
                    type="button"
                    showOnHover
                    aria-label={`Actions for ${concept.title}`}
                  />
                }
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="start" className="w-52">
                {concept.status === "active" && (
                  <DropdownMenuItem
                    onClick={() => onCreateDocument(spaceId, concept.id)}
                  >
                    <Plus /> New subdocument
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => onToggleDocumentLock(concept)}>
                  {concept.lockedAt ? <Unlock /> : <Lock />}
                  {concept.lockedAt ? "Unlock document" : "Lock document"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant={concept.status === "active"
                    ? "destructive"
                    : "default"}
                  onClick={() => onArchiveDocument(concept)}
                >
                  <Archive />
                  {concept.status === "active" ? "Archive" : "Restore"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {hasChildren && !collapsed && (
            <SidebarMenu className={NESTED_TREE}>
              {renderConcepts(spaceId, concept.id)}
            </SidebarMenu>
          )}
        </SidebarMenuItem>
      );
    });

  const activeImport = activeView === "imported"
    ? imports.find((item) => item.id === activeImportId)
    : undefined;
  const renderImports = (
    sourceId: string,
    folder: ImportFolder<SidebarImport>,
  ): React.ReactNode => [
    ...folder.folders.map((child) => {
      const key = `${sourceId}:${child.path}`;
      const expanded = expandedImportFolders.has(key) ||
        (activeImport?.sourceId === sourceId &&
          activeImport.path.startsWith(`${child.path}/`));
      return (
        <SidebarMenuItem key={key}>
          <SidebarMenuButton
            type="button"
            size="sm"
            tooltip={child.path}
            aria-expanded={expanded}
            onClick={() =>
              setExpandedImportFolders((current) => {
                const next = new Set(current);
                next.has(key) ? next.delete(key) : next.add(key);
                return next;
              })}
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
            <span>{child.name}</span>
          </SidebarMenuButton>
          <SidebarMenuBadge className="font-normal text-muted-foreground">
            {folderSize(child)}
          </SidebarMenuBadge>
          {expanded && (
            <SidebarMenu className={NESTED_TREE}>
              {renderImports(sourceId, child)}
            </SidebarMenu>
          )}
        </SidebarMenuItem>
      );
    }),
    ...folder.items.map((item) => (
      <SidebarMenuItem key={item.id}>
        <SidebarMenuButton
          type="button"
          size="sm"
          tooltip={item.title}
          isActive={activeImport?.id === item.id}
          onClick={() => onOpenImported(item.sourceId, item.path)}
        >
          <FileText />
          <span>{item.title}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )),
  ];

  const totalArtifacts =
    concepts.filter((item) =>
      item.status === "active" && item.type?.toLocaleLowerCase() === "artifact"
    ).length;

  const workspaceIdentity = (
    <>
      {workspace.logo
        ? (
          <img
            className="size-8 shrink-0 rounded-lg object-cover"
            src={workspace.logo}
            alt=""
          />
        )
        : (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary font-serif text-base text-sidebar-primary-foreground">
            {workspace.name.slice(0, 1).toUpperCase()}
          </span>
        )}
      <span className="grid min-w-0 flex-1 text-left leading-tight">
        <span className="truncate">{workspace.name}</span>
        <span className="truncate text-xs font-normal text-muted-foreground">
          {workspace.tagline}
        </span>
      </span>
    </>
  );

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {canEdit || access === "owner"
              ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <SidebarMenuButton
                        type="button"
                        size="lg"
                        tooltip={workspace.name}
                        className="font-semibold"
                      />
                    }
                  >
                    {workspaceIdentity}
                    <ChevronDown className="ml-auto" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    side="bottom"
                    align="start"
                    className="w-64"
                  >
                    {canEdit && (
                      <DropdownMenuItem onClick={onCreate}>
                        <Settings />
                        Workspace settings
                      </DropdownMenuItem>
                    )}
                    {access === "owner" && (
                      <DropdownMenuItem onClick={onManageAccess}>
                        <Users />
                        Manage access
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )
              : (
                <SidebarMenuButton
                  type="button"
                  size="lg"
                  tooltip={workspace.name}
                  onClick={onOpenHome}
                  className="font-semibold"
                >
                  {workspaceIdentity}
                </SidebarMenuButton>
              )}
          </SidebarMenuItem>
          {canEdit && (
            <SidebarMenuItem className="mt-2">
              <SidebarMenuButton
                type="button"
                tooltip="New document"
                className="bg-sidebar-primary pr-8 text-sidebar-primary-foreground hover:bg-sidebar-primary/90 hover:text-sidebar-primary-foreground"
                onClick={() => onCreateDocument()}
              >
                <Plus />
                <span>New document</span>
              </SidebarMenuButton>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuAction
                      type="button"
                      aria-label="More ways to create"
                      className="text-sidebar-primary-foreground hover:bg-sidebar-primary-foreground/15 hover:text-sidebar-primary-foreground"
                    />
                  }
                >
                  <ChevronDown />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="right"
                  align="start"
                  className="w-52"
                >
                  <DropdownMenuItem onClick={onCreateFromTemplate}>
                    <FileText /> From a template…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onCreateArtifact()}>
                    <Blocks /> Artifact
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  type="button"
                  tooltip="Home"
                  isActive={activeView === "home"}
                  onClick={onOpenHome}
                >
                  <Home />
                  <span>Home</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  type="button"
                  tooltip="Artifacts"
                  isActive={activeView === "artifacts"}
                  onClick={onOpenArtifacts}
                >
                  <Blocks />
                  <span>Artifacts</span>
                </SidebarMenuButton>
                {totalArtifacts > 0 && (
                  <SidebarMenuBadge className="font-normal text-muted-foreground">
                    {totalArtifacts}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup className="py-1">
          <SidebarGroupLabel>Spaces</SidebarGroupLabel>
          {canEdit && (
            <SidebarGroupAction
              type="button"
              title="Create space"
              aria-label="Create space"
              onClick={onCreateSpace}
            >
              <Plus />
            </SidebarGroupAction>
          )}
        </SidebarGroup>

        {spaces.map((space) => {
          const collapsed = collapsedSpaces.has(space.id);
          if (iconOnly) {
            const active =
              (activeView === "space" || activeView === "space_artifacts") &&
                activeSpaceId === space.id ||
              activeView === "concept" &&
                concepts.some((item) =>
                  item.id === currentConceptId && item.spaceId === space.id
                );
            return (
              <SidebarGroup className="py-0" key={space.id}>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        type="button"
                        tooltip={space.name}
                        isActive={active}
                        onClick={() => onOpenSpace(space.id)}
                      >
                        <span
                          aria-hidden="true"
                          className="flex size-5 shrink-0 items-center justify-center text-base leading-none"
                        >
                          <SpaceIcon value={space.icon} />
                        </span>
                        <span>{space.name}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            );
          }
          const active =
            (activeView === "space" || activeView === "space_artifacts") &&
            activeSpaceId === space.id;
          return (
            <SidebarGroup className="py-0" key={space.id}>
              <div className="relative">
                <button
                  type="button"
                  className="absolute top-1.5 left-2 z-10 flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  aria-label={`${
                    collapsed ? "Expand" : "Collapse"
                  } ${space.name}`}
                  aria-expanded={!collapsed}
                  onClick={() => toggleSpace(space.id)}
                >
                  {collapsed
                    ? <ChevronRight className="size-3.5" />
                    : <ChevronDown className="size-3.5" />}
                </button>
                <SidebarGroupLabel
                  render={<button type="button" />}
                  className={`gap-2 pl-9 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : ""
                  } ${canEdit ? "w-full pr-9" : "w-full"}`}
                  onClick={() => onOpenSpace(space.id)}
                  onDragOver={(event) => {
                    if (draggedId) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const source = concepts.find((item) =>
                      item.id === draggedId
                    );
                    if (source) {
                      onMoveDocument(source, {
                        spaceId: space.id,
                        parentId: null,
                        index: concepts.filter((item) =>
                          item.spaceId === space.id && item.parentId === null &&
                          item.id !== source.id
                        ).length,
                      });
                    }
                    setDraggedId(null);
                    setDropTarget(null);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="flex size-5 shrink-0 items-center justify-center text-base leading-none"
                  >
                    <SpaceIcon value={space.icon} />
                  </span>
                  <span className="truncate font-medium">{space.name}</span>
                  <span className="ml-auto tabular-nums text-muted-foreground">
                    {space.count}
                  </span>
                </SidebarGroupLabel>
                {canEdit && (
                  <SidebarGroupAction
                    className="top-1/2 right-2 -translate-y-1/2"
                    type="button"
                    title={`New document in ${space.name}`}
                    aria-label={`New document in ${space.name}`}
                    onClick={() => onCreateDocument(space.id)}
                  >
                    <Plus />
                  </SidebarGroupAction>
                )}
              </div>
              {!collapsed && (
                <SidebarGroupContent>
                  <SidebarMenu>
                    {renderConcepts(space.id, null)}
                  </SidebarMenu>
                </SidebarGroupContent>
              )}
            </SidebarGroup>
          );
        })}

        <SidebarSeparator className="mt-3" />

        {iconOnly
          ? (
            <SidebarGroup className="py-1">
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      type="button"
                      tooltip="Sources"
                      isActive={activeView === "sources"}
                      onClick={onOpenSources}
                    >
                      <Database />
                      <span>Sources</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )
          : (
            <SidebarGroup className="py-1">
              <SidebarGroupLabel>Sources</SidebarGroupLabel>
              <SidebarGroupAction
                type="button"
                title="Manage sources"
                aria-label="Manage sources"
                className={activeView === "sources"
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : undefined}
                onClick={onOpenSources}
              >
                <Settings />
              </SidebarGroupAction>
              <SidebarGroupContent>
                <SidebarMenu>
                  {sources.map((source) => {
                    const sourceImports = imports.filter((item) =>
                      item.sourceId === source.id
                    );
                    const active = activeImport?.sourceId === source.id;
                    const expanded = active || expandedSources.has(source.id);
                    return (
                      <SidebarMenuItem key={source.id}>
                        <SidebarMenuButton
                          type="button"
                          size="sm"
                          tooltip={source.name}
                          aria-expanded={expanded}
                          onClick={() =>
                            setExpandedSources((current) => {
                              const next = new Set(current);
                              next.has(source.id)
                                ? next.delete(source.id)
                                : next.add(source.id);
                              return next;
                            })}
                        >
                          {source.kind === "git" ? <Code2 /> : <Database />}
                          <span>{source.name}</span>
                        </SidebarMenuButton>
                        <SidebarMenuBadge className="font-normal text-muted-foreground">
                          {source.count}
                        </SidebarMenuBadge>
                        {expanded && (
                          <SidebarMenu className={NESTED_TREE}>
                            {renderImports(
                              source.id,
                              importTree(sourceImports),
                            )}
                          </SidebarMenu>
                        )}
                      </SidebarMenuItem>
                    );
                  })}
                  {!sources.length && access === "owner" && (
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        type="button"
                        size="sm"
                        className="text-muted-foreground"
                        onClick={onOpenSources}
                      >
                        <Plus />
                        <span>Connect a source</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<SidebarMenuButton type="button" size="lg" />}
              >
                <Avatar size="sm">
                  <AvatarFallback>{initials(user.name)}</AvatarFallback>
                </Avatar>
                <span className="grid min-w-0 flex-1 text-left leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {access} · {user.email}
                  </span>
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-64">
                <DropdownMenuItem onClick={onOpenDeveloper}>
                  <Code2 />
                  Developer settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Appearance</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={theme.choice}
                    onValueChange={(value) => setTheme(value as ThemeChoice)}
                  >
                    <DropdownMenuRadioItem value="light">
                      <Sun />
                      Light
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark">
                      <Moon />
                      Dark
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="system">
                      <Monitor />
                      System
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onSignOut}>
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
