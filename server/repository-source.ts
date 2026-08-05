/// <reference lib="deno.ns" />

import { parse } from "@std/yaml";

const decoder = new TextDecoder();
const MAX_FILE_BYTES = 512 * 1024;

export type RepositoryFile = {
  path: string;
  markdown: string;
  body: string;
  title: string;
  type: string;
  hash: string;
};

export type RepositoryIssue = { path: string; error: string };

export type RepositorySnapshot = {
  revision: string;
  files: RepositoryFile[];
  issues: RepositoryIssue[];
};

async function git(args: string[], cwd?: string) {
  const output = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      decoder.decode(output.stderr).trim() || "Git command failed",
    );
  }
  return decoder.decode(output.stdout).trim();
}

async function exists(path: string) {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function hash(markdown: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(markdown),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function inspectOkf(path: string, markdown: string) {
  const frontmatter = markdown.match(
    /^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?/,
  );
  if (!frontmatter) throw new Error("Missing YAML frontmatter");
  let metadata: unknown;
  try {
    metadata = parse(frontmatter[1]);
  } catch (error) {
    throw new Error(
      `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
    throw new Error("Frontmatter must be a YAML mapping");
  }
  const fields = metadata as Record<string, unknown>;
  if (typeof fields.type !== "string" || !fields.type.trim()) {
    throw new Error("Frontmatter requires a non-empty type");
  }
  const filename = path.split("/").pop()!.replace(/\.md$/i, "");
  return {
    path,
    markdown,
    body: markdown.slice(frontmatter[0].length),
    title: typeof fields.title === "string" && fields.title.trim()
      ? fields.title.trim()
      : filename.replaceAll("-", " "),
    type: fields.type.trim(),
    hash: await hash(markdown),
  };
}

async function readBundle(root: string) {
  const files: RepositoryFile[] = [];
  const issues: RepositoryIssue[] = [];

  async function walk(directory: string, relative = "") {
    const entries = [];
    for await (const entry of Deno.readDir(directory)) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = `${directory}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(absolute, path);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      if (["index.md", "log.md"].includes(entry.name.toLowerCase())) continue;
      if (entry.isSymlink) {
        issues.push({ path, error: "Symbolic links are not imported" });
        continue;
      }
      if ((await Deno.stat(absolute)).size > MAX_FILE_BYTES) {
        issues.push({ path, error: "File exceeds 512 KiB" });
        continue;
      }
      try {
        files.push(await inspectOkf(path, await Deno.readTextFile(absolute)));
      } catch (error) {
        issues.push({
          path,
          error: error instanceof Error ? error.message : "Invalid OKF",
        });
      }
    }
  }

  await walk(root);
  return { files, issues };
}

export async function syncRepository(
  checkout: string,
  repositoryUrl: string,
  folder: string,
): Promise<RepositorySnapshot> {
  if (
    !folder || folder.startsWith("/") || folder.includes("\\") ||
    folder.split("/").includes("..")
  ) {
    throw new Error("OKF folder must be repository-relative");
  }
  if (await exists(`${checkout}/.git`)) {
    await git(["fetch", "--depth=1", "origin"], checkout);
    await git(["reset", "--hard", "FETCH_HEAD"], checkout);
  } else {
    await Deno.remove(checkout, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    try {
      await git([
        "clone",
        "--depth=1",
        "--no-tags",
        repositoryUrl,
        checkout,
      ]);
    } catch (error) {
      await Deno.remove(checkout, { recursive: true }).catch(() => {});
      throw error;
    }
  }
  const revision = await git(["rev-parse", "HEAD"], checkout);
  const root = `${checkout}/${folder}`;
  if (!await exists(root)) {
    throw new Error(`OKF folder "${folder}" was not found at ${revision}`);
  }
  const rootInfo = await Deno.lstat(root);
  if (rootInfo.isSymlink || !rootInfo.isDirectory) {
    throw new Error(`OKF folder "${folder}" must be a directory, not a link`);
  }
  return { revision, ...await readBundle(root) };
}
