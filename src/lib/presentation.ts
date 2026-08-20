import { parseFrontmatter } from "./frontmatter.ts";

export function presentationSlides(markdown: string) {
  const body = parseFrontmatter(markdown).body.replace(
    /^#\s+[^\n]*(?:\n|$)/,
    "",
  );
  const slides: string[] = [];
  let lines: string[] = [];
  let fence = "";
  const commit = () => {
    const slide = lines.join("\n").trim();
    if (slide) slides.push(slide);
    lines = [];
  };

  for (const line of body.split("\n")) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      fence = fence === marker ? "" : fence || marker;
      lines.push(line);
      continue;
    }
    if (
      !fence &&
      (/^ {0,3}#{1,6}\s+/.test(line) || /^\s*(---|\*\*\*|___)\s*$/.test(line))
    ) {
      commit();
      if (!/^\s*(---|\*\*\*|___)\s*$/.test(line)) lines.push(line);
      continue;
    }
    lines.push(line);
  }
  commit();
  return slides;
}
