import { parse, stringify } from "@std/yaml";
import type { DatabaseSync } from "node:sqlite";

const controlled = new Set([
  "type",
  "title",
  "id",
  "status",
  "generated",
  "intent",
]);

export function extensionFields(
  markdown: string,
): Record<string, unknown> | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  const value = parse(match[1]);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !controlled.has(key)),
  );
}

export function extensionYaml(fields: Record<string, unknown>) {
  const preserved = Object.fromEntries(
    Object.entries(fields).filter(([key]) => !controlled.has(key)),
  );
  return Object.keys(preserved).length ? stringify(preserved) : "";
}

export function createFrontmatterStore(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS okf_document_frontmatter (
      conceptId TEXT PRIMARY KEY,
      fields TEXT NOT NULL
    );
    INSERT OR IGNORE INTO okf_document_frontmatter (conceptId, fields)
    SELECT conceptId, json_object('sources', json(sources)) FROM okf_concept_sources;
  `);
  return {
    get(id: string): Record<string, unknown> {
      const row = db.prepare(
        "SELECT fields FROM okf_document_frontmatter WHERE conceptId = ?",
      ).get(id) as { fields: string } | undefined;
      return parse(row?.fields ?? "{}") as Record<string, unknown>;
    },
    set(id: string, fields: Record<string, unknown>) {
      db.prepare(
        "INSERT OR REPLACE INTO okf_document_frontmatter (conceptId, fields) VALUES (?, ?)",
      ).run(id, extensionYaml(fields) || "{}");
    },
  };
}

export function editableSources(fields: Record<string, unknown> | null) {
  return Array.isArray(fields?.sources)
    ? fields.sources.filter((entry) =>
      typeof entry === "string" ||
      (entry && typeof entry === "object" && !Array.isArray(entry))
    )
    : [];
}

// Use the YAML serializer for type scalars such as "Null" and "true".
export function typeYaml(type: string) {
  return stringify({ type });
}
