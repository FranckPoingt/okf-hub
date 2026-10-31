import type { GitHubAppClient } from "./github-app.ts";

// Generic proposal transport: callers supply reviewed files and the evidence
// revision. No API in this module updates an existing ref (especially default).
export async function openRepositoryPR({
  app,
  installationId,
  repositoryId,
  revision,
  files,
  title,
  body,
  fetcher = fetch,
}: {
  app: GitHubAppClient;
  installationId: number;
  repositoryId: number;
  revision: string;
  files: { path: string; markdown: string }[];
  title: string;
  body: string;
  fetcher?: typeof fetch;
}) {
  const repo = (await app.repositories(installationId)).find((item) =>
    item.id === repositoryId
  );
  if (!repo) {
    throw new Error("Repository is not available to this installation");
  }
  if (
    !files.length ||
    files.some((file) =>
      !file.path || file.path.startsWith("/") || file.path.includes("\\") ||
      file.path.split("/").some((part) =>
        !part || part === "." || part === ".."
      )
    )
  ) throw new Error("Unsafe proposal paths");
  const { token } = await app.credentials(installationId);
  async function request(path: string, value?: unknown) {
    const response = await fetcher(
      `https://api.github.com/repos/${repo!.fullName}${path}`,
      {
        method: value ? "POST" : "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
        },
        ...(value ? { body: JSON.stringify(value) } : {}),
      },
    );
    // Do not relay provider bodies which may contain repository contents.
    if (!response.ok) {
      throw new Error(
        `GitHub proposal failed (${response.status}); check contents:write and pull_requests:write permissions`,
      );
    }
    return await response.json();
  }
  const base = await request(
    `/git/ref/heads/${encodeURIComponent(repo.defaultBranch)}`,
  );
  if (base.object.sha !== revision) {
    throw new Error("Repository changed; regenerate and review the draft");
  }
  const commit = await request(`/git/commits/${revision}`);
  const tree = await request("/git/trees", {
    base_tree: commit.tree.sha,
    tree: files.map((file) => ({
      path: file.path,
      mode: "100644",
      type: "blob",
      content: file.markdown,
    })),
  });
  const next = await request("/git/commits", {
    message: title,
    tree: tree.sha,
    parents: [revision],
  });
  const branch = `okf-proposal/${crypto.randomUUID()}`;
  if (branch === repo.defaultBranch) {
    throw new Error("Proposal branch must differ from default");
  }
  await request("/git/refs", { ref: `refs/heads/${branch}`, sha: next.sha });
  try {
    const pr = await request("/pulls", {
      title,
      body,
      head: branch,
      base: repo.defaultBranch,
      draft: true,
    });
    return { url: pr.html_url as string, branch };
  } catch (error) {
    // Only this call's successfully created proposal ref is eligible for cleanup.
    try {
      await fetcher(
        `https://api.github.com/repos/${repo.fullName}/git/refs/heads/${
          encodeURIComponent(branch)
        }`,
        {
          method: "DELETE",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
          },
        },
      );
    } catch {
      // Best effort; preserve the original proposal error.
    }
    throw error;
  }
}
