const variablePattern = /{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g;

export function templateVariables(markdown: string) {
  return Array.from(
    new Set(
      Array.from(markdown.matchAll(variablePattern), (match) => match[1]),
    ),
  );
}

export function renderTemplate(
  markdown: string,
  values: Record<string, unknown>,
): { error: string } | { body: string } {
  const missing = templateVariables(markdown).filter((name) =>
    !Object.hasOwn(values, name) || typeof values[name] !== "string" ||
    !values[name].trim()
  );
  if (missing.length) return { error: `Fill in ${missing.join(", ")}` };
  return {
    body: markdown.replace(
      variablePattern,
      (_match, name: string) => String(values[name]),
    ),
  };
}
