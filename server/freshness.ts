/// <reference lib="deno.ns" />

import { parse } from "@std/yaml";
import type { DatabaseSync } from "node:sqlite";
import { globPattern, ownersFor, readCodeowners } from "./codeowners.ts";
import { git, type RepositoryFile } from "./repository-source.ts";

const MAX_STALE_PATHS = 10;
const MAX_SOURCES = 50;

export type StaleReason = { from: string; to: string; paths: string[] };

export type ConceptFreshness = {
  describes: string[];
  describedOwners: string[];
  stale: StaleReason | null;
};

type PreviousConcept = { contentHash: string; stale: StaleReason | null };

const unique = (values: string[]) => Array.from(new Set(values));

export function staleMessage(stale: StaleReason) {
  return `Described code changed in ${stale.from.slice(0, 7)}..${
    stale.to.slice(0, 7)
  }: ${stale.paths.join(", ")}`;
}

// A new or edited concept is fresh; otherwise matching code changes make it
// stale, extending any earlier stale range so the original cause stays visible.
export function nextStale(
  previous: PreviousConcept | undefined,
  hash: string,
  matched: string[] | null,
  from: string,
  to: string,
): StaleReason | null {
  if (!previous || previous.contentHash !== hash) return null;
  if (!matched?.length) return previous.stale;
  return {
    from: previous.stale?.from ?? from,
    to,
    paths: unique([...previous.stale?.paths ?? [], ...matched]).slice(
      0,
      MAX_STALE_PATHS,
    ),
  };
}

// Null means the range is unknown (first import or missing history), which
// must never mark anything stale.
export async function changedPaths(
  checkout: string,
  from: string | null,
  to: string,
) {
  if (!from) return null;
  if (from === to) return [];
  try {
    return (await git(
      ["diff", "--name-only", "--no-renames", "-z", from, to, "--"],
      checkout,
    )).split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

async function trackedPaths(checkout: string) {
  try {
    return (await git(["ls-files", "-z"], checkout)).split("\0").filter(
      Boolean,
    );
  } catch {
    return [];
  }
}

// Fills CODEOWNERS owners into concepts without an explicit owner and returns
// the freshness state to store with the import, keyed by bundle path.
export async function inspectRepositoryFreshness(options: {
  checkout: string;
  folder: string;
  from: string | null;
  to: string;
  files: RepositoryFile[];
  previous: Map<string, PreviousConcept>;
}) {
  const { checkout, from, to, files } = options;
  const rules = await readCodeowners(checkout).catch(() => []);
  const changed = await changedPaths(checkout, from, to);
  const tracked = files.some((file) => file.describes?.length)
    ? await trackedPaths(checkout)
    : [];
  const prefix = options.folder.replace(/^\.?\/?|\/+$/g, "");
  const result = new Map<string, ConceptFreshness>();
  for (const file of files) {
    const repositoryPath = prefix ? `${prefix}/${file.path}` : file.path;
    if (!file.owner) {
      file.owner = ownersFor(rules, repositoryPath).join(" ");
      if (file.owner) file.searchText += `\n${file.owner}`;
    }
    const describes = file.describes ?? [];
    const patterns = describes.map(globPattern);
    const matches = (path: string) =>
      patterns.some((pattern) => pattern.test(path));
    result.set(file.path, {
      describes,
      describedOwners: unique(
        tracked.filter(matches).flatMap((path) => ownersFor(rules, path)),
      ),
      stale: nextStale(
        options.previous.get(file.path),
        file.hash,
        changed && changed.filter(matches),
        from ?? to,
        to,
      ),
    });
  }
  return result;
}

// `sources:` references from a document's frontmatter; null when the Markdown
// has no frontmatter, so body-only saves keep the stored references.
export function documentSources(markdown: string): string[] | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  let fields: unknown;
  try {
    fields = parse(match[1]);
  } catch {
    return null;
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return null;
  }
  const sources = (fields as Record<string, unknown>).sources;
  return unique(
    (Array.isArray(sources) ? sources : []).flatMap((entry) =>
      typeof entry === "string"
        ? [entry]
        : entry && typeof entry === "object"
        ? [
          (entry as Record<string, unknown>).resource,
          (entry as Record<string, unknown>).id,
        ]
        : []
    ).filter((value): value is string => typeof value === "string")
      .map((value) => value.trim()).filter(Boolean),
  ).slice(0, MAX_SOURCES);
}

export function createFreshnessStore(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS okf_concept_freshness (
      conceptId TEXT PRIMARY KEY,
      describes TEXT NOT NULL DEFAULT '[]',
      describedOwners TEXT NOT NULL DEFAULT '[]',
      stale TEXT
    );
    CREATE TABLE IF NOT EXISTS okf_concept_sources (
      conceptId TEXT PRIMARY KEY,
      sources TEXT NOT NULL DEFAULT '[]'
    );
  `);

  function get(conceptId: string): ConceptFreshness {
    const row = db.prepare(
      "SELECT describes, describedOwners, stale FROM okf_concept_freshness WHERE conceptId = ?",
    ).get(conceptId) as Record<string, string | null> | undefined;
    return {
      describes: JSON.parse(row?.describes ?? "[]"),
      describedOwners: JSON.parse(row?.describedOwners ?? "[]"),
      stale: row?.stale ? JSON.parse(row.stale) : null,
    };
  }

  function save(conceptId: string, value: ConceptFreshness) {
    db.prepare(
      "INSERT OR REPLACE INTO okf_concept_freshness (conceptId, describes, describedOwners, stale) VALUES (?, ?, ?, ?)",
    ).run(
      conceptId,
      JSON.stringify(value.describes),
      JSON.stringify(value.describedOwners),
      value.stale ? JSON.stringify(value.stale) : null,
    );
  }

  function setSources(conceptId: string, sources: string[]) {
    db.prepare(
      "INSERT OR REPLACE INTO okf_concept_sources (conceptId, sources) VALUES (?, ?)",
    ).run(conceptId, JSON.stringify(sources));
  }

  function referenceProblem(
    reference: string,
    seen: Set<string>,
  ): string | null {
    const hub = db.prepare("SELECT id, status FROM okf_concept WHERE id = ?")
      .get(reference.replace(/^\/knowledge\//, "")) as
        | { id: string; status: string }
        | undefined;
    if (hub) {
      if (hub.status !== "active") return "source archived";
      return seen.has(hub.id) ? null : dependency(hub.id, seen);
    }
    const path = reference.replace(/^\.?\//, "");
    const imported = db.prepare(
      "SELECT id, status FROM okf_imported_concept WHERE id = ? OR path = ? OR path = ? ORDER BY status = 'current' DESC LIMIT 1",
    ).get(reference, path, `${path}.md`) as
      | { id: string; status: string }
      | undefined;
    // Unresolved references are external resources, which are not tracked.
    if (!imported) return null;
    if (imported.status === "deleted" || imported.status === "renamed") {
      return "source missing";
    }
    const stale = get(imported.id).stale;
    return stale ? staleMessage(stale) : null;
  }

  // Derived on read: the first referenced concept that is stale or missing.
  // The label is the reference as written in the dependent document, so the
  // reason never discloses a title the reader may not be allowed to see.
  function dependency(
    conceptId: string,
    seen = new Set<string>(),
  ): string | null {
    seen.add(conceptId);
    const row = db.prepare(
      "SELECT sources FROM okf_concept_sources WHERE conceptId = ?",
    ).get(conceptId) as { sources: string } | undefined;
    for (const reference of JSON.parse(row?.sources ?? "[]") as string[]) {
      const problem = referenceProblem(reference, seen);
      if (problem) return `Depends on ${reference}: ${problem}`;
    }
    return null;
  }

  return { get, save, setSources, dependency };
}
