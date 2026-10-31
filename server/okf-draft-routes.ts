/// <reference lib="deno.ns" />
import type { AIResponder } from "./ai.ts";
import type { GitHubAppClient } from "./github-app.ts";
import { openRepositoryPR } from "./github-pr.ts";
import { createZip } from "./export-archive.ts";
import { draftOkf, emptyOkfFolder, repositoryInput } from "./okf-drafter.ts";
import type { createSecurity } from "./security.ts";

type Source = {
  folder: string;
  githubInstallationId: number | null;
  githubRepositoryId: number | null;
};
export function createOkfDraftRoutes(
  {
    dataDir,
    security,
    repositorySource,
    refreshing,
    connectorEnabled,
    responder,
    model,
    app,
  }: {
    dataDir: string;
    security: Pick<
      Awaited<ReturnType<typeof createSecurity>>,
      "session" | "checkSpace" | "ensureImportedSource" | "audit"
    >;
    repositorySource: (id: string) => Source | undefined;
    refreshing: (id: string) => boolean;
    connectorEnabled: () => boolean;
    responder: AIResponder | null;
    model: string;
    app: GitHubAppClient | null | undefined;
  },
) {
  const okfDrafts = new Map<string, {
    userId: string;
    source: string;
    revision: string;
    createdAt: number;
    draft: Awaited<ReturnType<typeof draftOkf>>;
  }>();
  const draftingSources = new Set<string>();
  return {
    busy: (id: string) => draftingSources.has(id),
    async handle(request: Request, sourceId: string, approve: boolean) {
      const current = await security.session(request);
      if (!current) {
        return Response.json({ error: "Sign in required" }, {
          status: 401,
        });
      }
      const source = repositorySource(sourceId);
      if (!source) {
        return Response.json({ error: "Repository not found" }, {
          status: 404,
        });
      }
      await security.ensureImportedSource(sourceId);
      if (
        !await security.checkSpace(
          current.user.id,
          "edit",
          `imported-${sourceId}`,
        )
      ) {
        return Response.json({ error: "Source editor access required" }, {
          status: 403,
        });
      }
      const checkout = `${dataDir}/sources/${sourceId}`;
      const eligible = Boolean(responder) && connectorEnabled() &&
        !refreshing(sourceId) &&
        await emptyOkfFolder(checkout, source.folder);
      if (request.method === "GET") {
        return Response.json({ available: eligible }, {});
      }
      if (!eligible || refreshing(sourceId)) {
        return Response.json({
          error: "Drafting requires configured AI and an empty OKF folder",
        }, { status: 409 });
      }
      if (draftingSources.has(sourceId)) {
        return Response.json({ error: "Draft operation already running" }, {
          status: 409,
        });
      }
      draftingSources.add(sourceId);
      try {
        for (const [id, proposal] of okfDrafts) {
          if (Date.now() - proposal.createdAt > 30 * 60_000) {
            okfDrafts.delete(id);
          }
        }
        const identity = JSON.stringify({ sourceId, source });
        if (approve) {
          const { draftId } = await request.json();
          const proposal = okfDrafts.get(draftId);
          if (
            JSON.stringify({ sourceId, source: repositorySource(sourceId) }) !==
              identity ||
            !proposal || proposal.userId !== current.user.id ||
            proposal.source !== identity
          ) {
            throw new Error(
              "Draft expired or source changed; regenerate and review",
            );
          }
          // Consume before external writes, preventing duplicate approvals.
          okfDrafts.delete(draftId);
          const folder = source.folder === "." ? "" : `${source.folder}/`;
          const files = proposal.draft.files.map((file) => ({
            ...file,
            path: folder + file.path,
          }));
          if (source.githubInstallationId) {
            if (!app || !source.githubRepositoryId) {
              throw new Error("GitHub App unavailable");
            }
            const result = await openRepositoryPR({
              app,
              installationId: source.githubInstallationId,
              repositoryId: source.githubRepositoryId,
              revision: proposal.revision,
              files,
              title: "Draft OKF repository knowledge",
              body:
                "AI-drafted OKF bundle, explicitly proposed by a Hub editor. Review every claim, source reference, and ownership detail before merging. This proposal does not approve or publish knowledge.",
            });
            security.audit(
              current.user.id,
              "source.okf-pr-proposed",
              `source:${sourceId}`,
            );
            return Response.json(result);
          }
          const zip = await createZip(
            files.map((file) => ({ path: file.path, body: file.markdown })),
          );
          security.audit(
            current.user.id,
            "source.okf-draft-exported",
            `source:${sourceId}`,
          );
          return new Response(zip, {
            headers: {
              "content-type": "application/zip",
              "content-disposition": 'attachment; filename="okf-draft.zip"',
            },
          });
        }
        if (okfDrafts.size >= 32) {
          throw new Error("Too many pending drafts; try again later");
        }
        const head = await new Deno.Command("git", {
          args: ["rev-parse", "HEAD"],
          cwd: checkout,
          stdout: "piped",
          stderr: "null",
        }).output();
        if (!head.success) {
          throw new Error("Refresh the repository before drafting");
        }
        const revision = new TextDecoder().decode(head.stdout).trim();
        const draft = await draftOkf(
          await repositoryInput(checkout),
          responder!,
          model,
        );
        if (
          JSON.stringify({ sourceId, source: repositorySource(sourceId) }) !==
            identity
        ) {
          throw new Error("Source changed; regenerate the draft");
        }
        const draftId = crypto.randomUUID();
        okfDrafts.set(draftId, {
          userId: current.user.id,
          source: identity,
          revision,
          draft,
          createdAt: Date.now(),
        });
        security.audit(
          current.user.id,
          "source.okf-drafted",
          `source:${sourceId}`,
        );
        return Response.json({ draftId, ...draft });
      } catch (error) {
        security.audit(
          current.user.id,
          "source.okf-draft-failed",
          `source:${sourceId}`,
        );
        return Response.json({
          error: error instanceof Error ? error.message : "Draft failed",
        }, { status: 400 });
      } finally {
        draftingSources.delete(sourceId);
      }
    },
  };
}
