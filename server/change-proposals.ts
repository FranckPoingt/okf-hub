/// <reference lib="deno.ns" />
import type { DatabaseSync } from "node:sqlite";
import type { GitHubAppClient } from "./github-app.ts";
import { openRepositoryPR } from "./github-pr.ts";
import type { createSecurity } from "./security.ts";

type Source = {
  folder: string;
  githubInstallationId: number | null;
  githubRepositoryId: number | null;
  githubFullName: string | null;
};
type Concept = {
  id: string;
  title: string;
  objectKey: string;
  sourceRevision: string;
};
type Proposal = {
  prUrl: string;
  prNumber: number;
  status: "open" | "merged" | "closed";
  createdAt: string;
};

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?/;
const MAX_BODY = 512 * 1024;
const MAX_RATIONALE = 1000;
class ProposalError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// Concept paths are relative to the OKF folder; return the repository path.
export function repositoryPath(folder: string, path: string) {
  const parts = path.split("/");
  if (
    !path.endsWith(".md") || path.includes("\\") || path.includes("\0") ||
    path.startsWith("/") ||
    parts.some((part) => !part || part === "." || part === "..")
  ) throw new ProposalError("Concept path is outside the OKF folder", 400);
  return folder === "." ? path : `${folder}/${path}`;
}

// A zero-width space stops user text from @mentioning (and notifying) people.
const inert = (text: string) => text.replaceAll("@", "@​");

export function proposalBody(
  { rationale, name, link, revision }: {
    rationale: string;
    name: string;
    link: string;
    revision: string;
  },
) {
  return [
    "## Why",
    inert(rationale),
    "",
    `Suggested by **${inert(name)}** in OKF Hub: ${link}`,
    `Based on repository revision \`${revision}\`.`,
    "",
    "This draft pull request is only a suggestion. Merging it is the approval; the Hub copy changes after the source next syncs.",
  ].join("\n");
}

export async function buildPatch(
  { revision, path, before, after, name, subject, rationale, tempDir }: {
    revision: string;
    path: string;
    before: string;
    after: string;
    name: string;
    subject: string;
    rationale: string;
    // The server may only write under its data directory, not the system tmp.
    tempDir?: string;
  },
) {
  const dir = await Deno.makeTempDir({ dir: tempDir });
  try {
    for (const [side, content] of [["a", before], ["b", after]]) {
      const file = `${dir}/${side}/${path}`;
      await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(file, content);
    }
    const diff = await new Deno.Command("git", {
      args: [
        "-c",
        "core.quotepath=false",
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-color",
        "--src-prefix=",
        "--dst-prefix=",
        "--",
        `a/${path}`,
        `b/${path}`,
      ],
      cwd: dir,
      stdout: "piped",
      stderr: "null",
    }).output();
    // Exit code 1 means "files differ".
    if (diff.code > 1) throw new Error("Could not build the patch");
    const date = new Date().toUTCString().replace("GMT", "+0000");
    return `From ${revision} Mon Sep 17 00:00:00 2001\nFrom: ${
      name.replace(/[<>\r\n]/g, " ")
    } <noreply@okf-hub.invalid>\nDate: ${date}\nSubject: [PATCH] ${
      subject.replace(/[\r\n]/g, " ")
    }\n\n${rationale}\n---\n${
      new TextDecoder().decode(diff.stdout)
    }-- \nOKF Hub\n`;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

export function createChangeProposalRoutes(
  {
    db,
    security,
    repositorySource,
    read,
    app,
    baseUrl,
    tempDir,
    fetcher = fetch,
  }: {
    db: DatabaseSync;
    security: Pick<
      Awaited<ReturnType<typeof createSecurity>>,
      "session" | "check" | "checkSpace" | "ensureImportedSource" | "audit"
    >;
    repositorySource: (id: string) => Source | undefined;
    read: (objectKey: string) => Promise<string>;
    app: GitHubAppClient | null | undefined;
    baseUrl?: string;
    tempDir?: string;
    fetcher?: typeof fetch;
  },
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS okf_change_proposal (
      id TEXT PRIMARY KEY,
      sourceId TEXT NOT NULL,
      conceptId TEXT NOT NULL,
      userId TEXT NOT NULL,
      prUrl TEXT NOT NULL,
      prNumber INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'merged', 'closed')),
      createdAt TEXT NOT NULL
    )
  `);
  const concept = (sourceId: string, path: string) =>
    db.prepare(
      "SELECT id, title, objectKey, sourceRevision FROM okf_imported_concept WHERE sourceId = ? AND path = ? AND status = 'current'",
    ).get(sourceId, path) as Concept | undefined;
  const proposals = (conceptId: string) =>
    db.prepare(
      "SELECT prUrl, prNumber, status, createdAt FROM okf_change_proposal WHERE conceptId = ? ORDER BY createdAt DESC LIMIT 10",
    ).all(conceptId) as Proposal[];
  const fail = (error: string, status: number) =>
    Response.json({ error }, { status });

  return {
    updateStatus(
      installationId: number,
      repositoryId: number,
      prNumber: number,
      status: Proposal["status"],
    ) {
      return db.prepare(
        `UPDATE okf_change_proposal SET status = ? WHERE prNumber = ?
        AND sourceId IN (SELECT id FROM okf_repository_source
          WHERE githubInstallationId = ? AND githubRepositoryId = ?)`,
      )
        .run(status, prNumber, installationId, repositoryId).changes;
    },
    // Best-effort: called after a source sync, so merged/closed PRs show up.
    async refresh(sourceId: string) {
      const source = repositorySource(sourceId);
      const open = db.prepare(
        "SELECT id, prNumber FROM okf_change_proposal WHERE sourceId = ? AND status = 'open'",
      ).all(sourceId) as { id: string; prNumber: number }[];
      if (!app || !source?.githubInstallationId || !open.length) return;
      try {
        const { token } = await app.credentials(source.githubInstallationId);
        for (const item of open) {
          const response = await fetcher(
            `https://api.github.com/repos/${source.githubFullName}/pulls/${item.prNumber}`,
            {
              headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${token}`,
                "x-github-api-version": "2022-11-28",
              },
            },
          );
          if (!response.ok) continue;
          const pr = await response.json();
          const status = pr.merged_at
            ? "merged"
            : pr.state === "closed"
            ? "closed"
            : "open";
          if (status !== "open") {
            db.prepare("UPDATE okf_change_proposal SET status = ? WHERE id = ?")
              .run(status, item.id);
          }
        }
      } catch {
        // Stale status is acceptable; the next sync retries.
      }
    },
    forget(sourceId: string) {
      db.prepare("DELETE FROM okf_change_proposal WHERE sourceId = ?").run(
        sourceId,
      );
    },
    async handle(request: Request, sourceId: string) {
      const current = await security.session(request);
      if (!current) return fail("Sign in required", 401);
      const source = repositorySource(sourceId);
      if (!source) return fail("Repository not found", 404);
      await security.ensureImportedSource(sourceId);
      // Suggesting needs the same access as drafting: source-space editors.
      const canPropose = await security.checkSpace(
        current.user.id,
        "edit",
        `imported-${sourceId}`,
      );
      const mode = source.githubInstallationId
        ? app ? "pull-request" : null
        : "patch";
      try {
        if (request.method === "GET") {
          const item = concept(
            sourceId,
            new URL(request.url).searchParams.get("path") ?? "",
          );
          if (
            !item || !await security.check(current.user.id, "view", item.id)
          ) return fail("Not found", 404);
          const list = proposals(item.id);
          return Response.json({
            mode,
            canPropose: canPropose && mode !== null,
            openCount: list.filter((entry) => entry.status === "open").length,
            proposals: list,
          });
        }
        if (!canPropose) return fail("Source editor access required", 403);
        if (!mode) return fail("GitHub App unavailable", 409);
        const input = await request.json().catch(() => ({})) as Record<
          string,
          unknown
        >;
        const { path, baseRevision, body } = input;
        const rationale = String(input.rationale ?? "").trim();
        if (
          typeof path !== "string" || typeof baseRevision !== "string" ||
          typeof body !== "string" || body.length > MAX_BODY ||
          !rationale || rationale.length > MAX_RATIONALE
        ) {
          throw new ProposalError(
            "Provide the edited body and a rationale of up to 1,000 characters",
            400,
          );
        }
        const repoPath = repositoryPath(source.folder, path);
        const item = concept(sourceId, path);
        if (!item) return fail("Concept not found", 404);
        if (item.sourceRevision !== baseRevision) {
          throw new ProposalError(
            "The source changed after you started editing. Reload the concept and apply your edit again.",
            409,
          );
        }
        const before = await read(item.objectKey);
        const frontmatter = before.match(FRONTMATTER)?.[0] ?? "";
        const after = frontmatter + body.trimEnd() + "\n";
        if (after === before || after.trimEnd() === before.trimEnd()) {
          throw new ProposalError("Make a change before suggesting it", 400);
        }
        const title = `Suggest change: ${item.title}`.slice(0, 100);
        const name = current.user.name || "A Hub user";
        if (mode === "patch") {
          const patch = await buildPatch({
            revision: item.sourceRevision,
            path: repoPath,
            before,
            after,
            name,
            subject: title,
            rationale,
            tempDir,
          });
          security.audit(
            current.user.id,
            "source.change-patch-exported",
            `concept:${item.id}`,
          );
          return new Response(patch, {
            headers: {
              "content-type": "text/x-diff; charset=utf-8",
              "content-disposition":
                'attachment; filename="okf-suggestion.patch"',
            },
          });
        }
        const link = new URL(
          `/imports/${encodeURIComponent(sourceId)}/${
            path.split("/").map(encodeURIComponent).join("/")
          }`,
          baseUrl ?? request.url,
        ).href;
        let pr;
        try {
          pr = await openRepositoryPR({
            app: app!,
            installationId: source.githubInstallationId!,
            repositoryId: source.githubRepositoryId!,
            revision: item.sourceRevision,
            files: [{ path: repoPath, markdown: after }],
            title,
            body: proposalBody({
              rationale,
              name,
              link,
              revision: item.sourceRevision,
            }),
            fetcher,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith("Repository changed")
          ) {
            throw new ProposalError(
              "The repository has changed since the last sync. Refresh the source, then apply your edit again.",
              409,
            );
          }
          throw error;
        }
        db.prepare(
          "INSERT INTO okf_change_proposal (id, sourceId, conceptId, userId, prUrl, prNumber, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)",
        ).run(
          crypto.randomUUID(),
          sourceId,
          item.id,
          current.user.id,
          pr.url,
          Number(pr.url.match(/\/pull\/(\d+)$/)?.[1] ?? 0),
          new Date().toISOString(),
        );
        security.audit(
          current.user.id,
          "source.change-proposed",
          `concept:${item.id}`,
        );
        return Response.json({ url: pr.url });
      } catch (error) {
        if (error instanceof ProposalError) {
          return fail(error.message, error.status);
        }
        return fail(
          error instanceof Error ? error.message : "Suggestion failed",
          502,
        );
      }
    },
  };
}
