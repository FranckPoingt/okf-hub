export interface DocumentFrontmatter {
  title?: string;
  type?: string;
  intent?: string;
  tags?: string[];
  attributes?: Record<string, string>;
}

export function parseFrontmatter(markdown: string): {
  frontmatter: DocumentFrontmatter;
  body: string;
} {
  if (!markdown || !markdown.startsWith("---")) {
    return { frontmatter: {}, body: markdown };
  }

  const lines = markdown.split("\n");
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    return { frontmatter: {}, body: markdown };
  }

  const fmLines = lines.slice(1, endIdx);
  const bodyLines = lines.slice(endIdx + 1);

  const frontmatter: DocumentFrontmatter = {
    tags: [],
    attributes: {},
  };

  let inTagsArray = false;

  for (const line of fmLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (inTagsArray && trimmed.startsWith("- ")) {
      const tag = trimmed.slice(2).trim();
      if (tag) frontmatter.tags?.push(tag);
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx !== -1) {
      const key = trimmed.slice(0, colonIdx).trim();
      let value = trimmed.slice(colonIdx + 1).trim();

      // Remove quotes if present
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (key === "tags") {
        inTagsArray = true;
        if (value.startsWith("[") && value.endsWith("]")) {
          frontmatter.tags = value
            .slice(1, -1)
            .split(",")
            .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
            .filter(Boolean);
          inTagsArray = false;
        }
      } else {
        inTagsArray = false;
        if (key === "title") frontmatter.title = value;
        else if (key === "type") frontmatter.type = value;
        else if (key === "intent") frontmatter.intent = value;
        else if (frontmatter.attributes) {
          frontmatter.attributes[key] = value;
        }
      }
    }
  }

  return { frontmatter, body: bodyLines.join("\n") };
}

export function updateFrontmatter(
  markdown: string,
  updatedFM: Partial<DocumentFrontmatter>,
): string {
  const { frontmatter, body } = parseFrontmatter(markdown);
  const mergedFM: DocumentFrontmatter = {
    ...frontmatter,
    ...updatedFM,
    attributes: {
      ...(frontmatter.attributes ?? {}),
      ...(updatedFM.attributes ?? {}),
    },
  };

  const lines: string[] = ["---"];

  if (mergedFM.title) {
    lines.push(`title: "${mergedFM.title.replace(/"/g, '\\"')}"`);
  }
  if (mergedFM.type) lines.push(`type: ${mergedFM.type}`);
  if (mergedFM.intent) lines.push(`intent: ${mergedFM.intent}`);

  if (mergedFM.tags && mergedFM.tags.length > 0) {
    lines.push("tags:");
    for (const tag of mergedFM.tags) {
      lines.push(`  - ${tag}`);
    }
  }

  if (mergedFM.attributes) {
    for (const [k, v] of Object.entries(mergedFM.attributes)) {
      if (v !== undefined && v !== null && v !== "") {
        lines.push(`${k}: "${v.replace(/"/g, '\\"')}"`);
      }
    }
  }

  lines.push("---");
  lines.push(body.trimStart());

  return lines.join("\n");
}
