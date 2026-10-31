/// <reference lib="deno.ns" />

const MAX_CODEOWNERS_BYTES = 3 * 1024 * 1024;
const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
];

export type CodeownersRule = { pattern: RegExp; owners: string[] };

// Gitignore-style glob shared by CODEOWNERS and `describes:`: a pattern with a
// slash is anchored to the repository root, `*` stays inside one segment, `**`
// crosses segments, and a pattern naming a directory covers everything in it.
export function globPattern(glob: string) {
  let value = glob.trim();
  const directory = value.endsWith("/");
  value = value.replace(/\/+$/, "");
  const anchored = value.includes("/");
  value = value.replace(/^\/+/, "");
  let source = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "*" && value[index + 1] === "*") {
      index++;
      if (value[index + 1] === "/") {
        index++;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const suffix = directory
    ? "/.*"
    : value.split("/").pop()!.includes("*")
    ? ""
    : "(?:/.*)?";
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${source}${suffix}$`);
}

export function parseCodeowners(text: string): CodeownersRule[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const [glob, ...owners] = line.replace(/(^|\s)#.*$/, "").trim().split(
      /\s+/,
    );
    return glob ? [{ pattern: globPattern(glob), owners }] : [];
  });
}

// GitHub semantics: the last matching rule wins, even when it lists no owners.
export function ownersFor(rules: CodeownersRule[], path: string) {
  for (let index = rules.length - 1; index >= 0; index--) {
    if (rules[index].pattern.test(path)) return rules[index].owners;
  }
  return [];
}

// GitHub uses the first CODEOWNERS found in .github/, the root, then docs/.
export async function readCodeowners(checkout: string) {
  for (const path of CODEOWNERS_PATHS) {
    try {
      const info = await Deno.lstat(`${checkout}/${path}`);
      if (!info.isFile || info.size > MAX_CODEOWNERS_BYTES) continue;
      return parseCodeowners(await Deno.readTextFile(`${checkout}/${path}`));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return [];
}
