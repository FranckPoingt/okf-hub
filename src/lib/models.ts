export type Invitation = {
  invitationId: string;
  email: string;
  access: string;
  url: string;
  status: string;
};
export type AIConfig = {
  enabled: boolean;
  provider: string;
  model: string;
};
export type Bootstrap = {
  user: { id: string; name: string; email: string } | null;
  access?: "owner" | "editor" | "viewer" | "none";
  canView?: boolean;
  canEdit?: boolean;
  signupAllowed?: boolean;
  ssoProviders?: {
    providerId: string;
    name: string;
    type: "oidc" | "saml";
  }[];
  setupRequired?: boolean;
  invitationRequired?: boolean;
  invitations?: Invitation[];
  workspace?: { name: string; tagline: string; logo: string };
  members?: {
    id: string;
    name: string;
    email: string;
    access: "owner" | "editor" | "viewer" | "member";
  }[];
  groups?: {
    id: string;
    name: string;
    access: "editor" | "viewer";
    memberCount: number;
  }[];
};
export type AuditEvent = { occurredAt: string; action: string; target: string };
export type ActivityEvent = AuditEvent & {
  actorUserId: string;
  actorName: string | null;
};
export type Revision = {
  number: number;
  publishedAt: string;
  actorUserId: string;
};
export type DocumentIntent = "canonical" | "working" | "evidence" | "ephemeral";
export type WorkTrace = {
  id: string;
  conceptId: string;
  conceptTitle: string;
  kind: "change" | "decision" | "incident" | "outcome";
  title: string;
  summary: string;
  occurredAt: string;
  sourceUrl: string;
  actorUserId: string;
  createdAt: string;
  foldedIntoConceptId: string | null;
  foldedIntoTitle: string | null;
  foldedAt: string | null;
  foldedKnowledge: string | null;
};
export type Concept = {
  id: string;
  spaceId: string;
  parentId: string | null;
  sortOrder: number;
  collabEpoch: number;
  space: string;
  title: string;
  type: string;
  intent: DocumentIntent;
  status: "active" | "archived";
  publishedRevision: number | null;
  lockedAt: string | null;
  lockedBy: string | null;
  updatedAt: string;
  draft: string | null;
  published: string | null;
  revisions: Revision[];
  activity: ActivityEvent[];
  workTraces: WorkTrace[];
  openCommentCount: number;
};
export type CommentMessage = {
  id: string;
  threadId: string;
  authorId: string;
  authorName: string | null;
  authorEmail: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
};
export type CommentThread = {
  id: string;
  conceptId: string;
  anchorText: string;
  anchorStart: number | null;
  anchorEnd: number | null;
  revisionNumber: number | null;
  createdBy: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  comments: CommentMessage[];
};
export type Space = { id: string; name: string; icon: string; count: number };
export type DocumentTemplate = {
  id: string;
  name: string;
  description: string;
  body: string;
  variables: string[];
  builtIn: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
export type SourceIssue = {
  path: string;
  status: "invalid" | "deleted" | "renamed";
  error: string | null;
  nextPath: string | null;
};
export type SourceSync = {
  id: number;
  sourceId: string;
  trigger: "connect" | "manual" | "webhook" | "scheduled";
  status: "running" | "succeeded" | "failed";
  revision: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};
export type RepositorySource = {
  id: string;
  kind: "git" | "github";
  repositoryUrl: string;
  folder: string;
  githubFullName: string | null;
  credentialsConfigured: boolean;
  status: "syncing" | "current" | "sync_failed";
  revision: string | null;
  lastSyncedAt: string | null;
  error: string | null;
  conceptCount: number;
  automationIntervalMinutes: number;
  issues: SourceIssue[];
  syncs: SourceSync[];
};
export type SharedSource = {
  id: "shared";
  kind: "s3";
  endpoint: string;
  bucket: string;
  path: string;
  region: string;
  credentialsConfigured: true;
  status: "syncing" | "current" | "sync_failed";
  revision: string | null;
  lastSyncedAt: string | null;
  error: string | null;
  conceptCount: number;
  automationIntervalMinutes: number;
  issues: SourceIssue[];
  syncs: SourceSync[];
};
export type NotionSource = {
  id: "notion";
  kind: "notion";
  credentialsConfigured: true;
  status: "syncing" | "current" | "sync_failed";
  revision: string | null;
  lastSyncedAt: string | null;
  error: string | null;
  conceptCount: number;
  automationIntervalMinutes: number;
  issues: SourceIssue[];
  syncs: SourceSync[];
};
export type Sources = {
  connectors: import("./connectors.ts").ConnectorDefinition[];
  repositories: RepositorySource[];
  shared: SharedSource | null;
  notion: NotionSource | null;
};
export type ImportedConcept = {
  id: string;
  sourceId: string;
  path: string;
  title: string;
  type: string;
  status: "current" | "invalid";
  sourceRevision: string;
  importedAt: string;
  tags: string[];
  owner: string;
  markdown?: string;
  revisionCount?: number;
  source?: RepositorySource | SharedSource | NotionSource;
};
export type SearchRelationship = {
  id: string;
  kind: "hub-native" | "imported";
  sourceId: string;
  title: string;
  path?: string;
  trust: "current" | "sync_failed";
  sourceLabel: string;
};
export type SearchResult = SearchRelationship & {
  type: string;
  tags: string[];
  owner: string;
  status: "active" | "archived" | "current";
  sourceStatus: "current" | "sync_failed";
  sourceRevision?: string;
  importedAt?: string;
  snippet: string;
  links: SearchRelationship[];
  backlinks: SearchRelationship[];
};
export type SearchResponse = {
  query: string;
  results: SearchResult[];
  facets: { types: string[]; tags: string[] };
  canIncludeArchived: boolean;
};
export type AutomationProposal = {
  sourceId: string;
  path: string;
  href: string;
  target: string;
  action: "fix_broken_link";
};
export type AutomationAttempt = {
  id: number;
  job: "source_check" | "broken_links";
  sourceId: string | null;
  attempt: number;
  status: "running" | "succeeded" | "failed";
  error: string | null;
  result: {
    revision?: string;
    conceptCount?: number;
    checkedConcepts?: number;
    proposals?: AutomationProposal[];
  } | null;
};
export type AutomationRun = {
  id: number;
  trigger: "manual" | "scheduled";
  status: "running" | "succeeded" | "partial";
  startedAt: string;
  finishedAt: string | null;
  attempts: AutomationAttempt[];
};
export type AutomationState = {
  intervalMs: number;
  running: boolean;
  runs: AutomationRun[];
};
export type ArtifactVersion = {
  number: number;
  createdBy: string;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
};
export type Artifact = {
  id: string;
  conceptId: string;
  title: string;
  description: string;
  grants: string[];
  type: "inline_html" | "https_url";
  status: "draft" | "live" | "changes_pending";
  draftVersion?: number;
  liveVersion: number | null;
  version: number;
  content?: string;
  bundle?: { entry: string; files: string[] };
  document?: string;
  url?: string;
  versions: ArtifactVersion[];
  updatedAt: string;
};
export type ArtifactState = {
  artifacts: Artifact[];
  apps?: Artifact[];
  allowedHosts: string[];
  availableActions?: {
    name: string;
    title: string;
    description: string;
    mode: "query" | "mutation";
    approval: "none" | "confirm";
  }[];
  canEdit: boolean;
  canPublish: boolean;
};
