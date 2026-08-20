/// <reference lib="deno.ns" />

import { createHmac, sign, timingSafeEqual } from "node:crypto";

const encoder = new TextEncoder();
const API_VERSION = "2022-11-28";

export type GitHubRepository = {
  id: number;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
};

export type GitHubAppClient = {
  slug: string;
  installUrl: string;
  repositories(installationId: number): Promise<GitHubRepository[]>;
  folders(
    installationId: number,
    repository: GitHubRepository,
  ): Promise<string[]>;
  credentials(installationId: number): Promise<{
    username: string;
    token: string;
  }>;
  verify(body: Uint8Array, signature: string): boolean;
};

function base64url(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-")
    .replaceAll("/", "_").replace(/=+$/, "");
}

export function createGitHubAppClient({
  appId,
  slug,
  privateKey,
  webhookSecret,
  fetcher = fetch,
  now = () => Date.now(),
  apiBase = "https://api.github.com",
}: {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  fetcher?: typeof fetch;
  now?: () => number;
  apiBase?: string;
}): GitHubAppClient {
  const normalizedKey = privateKey.replaceAll("\\n", "\n");

  function jwt() {
    const issuedAt = Math.floor(now() / 1000) - 60;
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({
      iat: issuedAt,
      exp: issuedAt + 10 * 60,
      iss: appId,
    }));
    const value = `${header}.${payload}`;
    return `${value}.${
      base64url(sign("RSA-SHA256", encoder.encode(value), normalizedKey))
    }`;
  }

  async function request<T>(path: string, token: string, init?: RequestInit) {
    const response = await fetcher(`${apiBase}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": API_VERSION,
        ...init?.headers,
      },
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        `GitHub returned ${response.status}: ${message.slice(0, 300)}`,
      );
    }
    return await response.json() as T;
  }

  async function installationToken(installationId: number) {
    const result = await request<{ token: string }>(
      `/app/installations/${installationId}/access_tokens`,
      jwt(),
      { method: "POST" },
    );
    return result.token;
  }

  return {
    slug,
    installUrl: `https://github.com/apps/${
      encodeURIComponent(slug)
    }/installations/new`,
    async repositories(installationId) {
      const result = await request<{
        repositories: Array<{
          id: number;
          full_name: string;
          clone_url: string;
          default_branch: string;
          private: boolean;
        }>;
      }>(
        "/installation/repositories?per_page=100",
        await installationToken(installationId),
      );
      return result.repositories.map((repository) => ({
        id: repository.id,
        fullName: repository.full_name,
        cloneUrl: repository.clone_url,
        defaultBranch: repository.default_branch,
        private: repository.private,
      })).sort((left, right) => left.fullName.localeCompare(right.fullName));
    },
    async folders(installationId, repository) {
      const result = await request<{
        tree: Array<{ path: string; type: "blob" | "tree" }>;
      }>(
        `/repos/${repository.fullName}/git/trees/${
          encodeURIComponent(repository.defaultBranch)
        }?recursive=1`,
        await installationToken(installationId),
      );
      return [
        ".",
        ...result.tree.filter((item) => item.type === "tree")
          .map((item) => item.path).sort(),
      ];
    },
    async credentials(installationId) {
      return {
        username: "x-access-token",
        token: await installationToken(installationId),
      };
    },
    verify(body, signature) {
      const expected = `sha256=${
        createHmac("sha256", webhookSecret).update(body).digest("hex")
      }`;
      const received = encoder.encode(signature);
      const computed = encoder.encode(expected);
      return received.length === computed.length &&
        timingSafeEqual(received, computed);
    },
  };
}
