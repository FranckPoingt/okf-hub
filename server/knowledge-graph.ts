import { parse } from "@std/yaml";
import type { Freshness } from "../src/lib/governance.ts";
import {
  type LinkDocument,
  resolveKnowledgeLink,
} from "../src/lib/knowledge-links.ts";

export type GraphDocument = LinkDocument & {
  title: string;
  type: string;
  sourceLabel: string;
  trust: "current" | "stale" | "sync_failed";
  trustReason?: string;
  freshness?: Freshness;
  stableId?: string;
  linkHrefs: string[];
};

export function definitionContent(markdown: string) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?/);
  let stableId: string | undefined;
  if (match) {
    try {
      const metadata = parse(match[1]) as Record<string, unknown> | null;
      if (typeof metadata?.id === "string" && metadata.id.trim()) {
        stableId = metadata.id.trim();
      }
    } catch {
      // Last healthy content can remain readable after a failed source sync.
    }
  }
  return { stableId, body: match ? markdown.slice(match[0].length) : markdown };
}

const normalized = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

function relationship(item: GraphDocument) {
  return {
    id: item.id,
    kind: item.kind,
    sourceId: item.sourceId,
    title: item.title,
    path: item.path,
    trust: item.trust,
    trustReason: item.trustReason,
    freshness: item.freshness,
    sourceLabel: item.sourceLabel,
  };
}

// Security boundary: documents MUST already be filtered for view access and
// draft/publication visibility. Never group first and filter the output later:
// even a group size would disclose hidden knowledge.
export function buildKnowledgeGraph(documents: readonly GraphDocument[]) {
  const byId = new Map(documents.map((item) => [item.id, item]));
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  const linkTargets = new Map<string, Record<string, string>>();
  for (const item of documents) {
    const targets = new Set<string>();
    const resolved: Record<string, string> = Object.create(null);
    for (const href of item.linkHrefs) {
      const link = resolveKnowledgeLink(item, href, documents);
      if (!link) continue;
      resolved[href] = link.href;
      if (link.target.id === item.id) continue;
      targets.add(link.target.id);
      const sources = incoming.get(link.target.id) ?? new Set<string>();
      sources.add(item.id);
      incoming.set(link.target.id, sources);
    }
    outgoing.set(item.id, targets);
    linkTargets.set(item.id, resolved);
  }

  // Union both identity keys so an explicit id can survive a type/title rename.
  const parent = new Map(documents.map((item) => [item.id, item.id]));
  const root = (id: string): string => {
    const next = parent.get(id)!;
    if (next === id) return id;
    const result = root(next);
    parent.set(id, result);
    return result;
  };
  const identities = new Map<string, string>();
  for (const item of documents) {
    const keys = [
      `title:${
        JSON.stringify([normalized(item.type), normalized(item.title)])
      }`,
    ];
    if (item.stableId) keys.push(`id:${item.stableId}`);
    for (const key of keys) {
      const other = identities.get(key);
      if (other) parent.set(root(item.id), root(other));
      else identities.set(key, item.id);
    }
  }
  const groups = new Map<string, GraphDocument[]>();
  for (const item of documents) {
    const key = root(item.id);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return new Map(documents.map((item) => {
    const peers = groups.get(root(item.id))!.filter((peer) =>
      peer.sourceId !== item.sourceId
    );
    return [item.id, {
      links: Array.from(
        outgoing.get(item.id) ?? [],
        (id) => relationship(byId.get(id)!),
      ),
      backlinks: Array.from(
        incoming.get(item.id) ?? [],
        (id) => relationship(byId.get(id)!),
      ),
      linkTargets: linkTargets.get(item.id)!,
      alsoDefinedIn: peers.map(relationship),
    }];
  }));
}
