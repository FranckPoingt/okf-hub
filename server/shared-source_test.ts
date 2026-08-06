/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { createObjectStore } from "./object-store.ts";
import { syncSharedSource } from "./shared-source.ts";

Deno.test("indexes a paginated S3 OKF bundle and isolates bad objects", async () => {
  const requests: URL[] = [];
  let deleted = false;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const url = new URL(request.url);
      requests.push(url);
      assert.match(request.headers.get("authorization") ?? "", /^AWS4-HMAC/);
      if (
        request.method === "DELETE" &&
        url.pathname.endsWith("/company/okf/good.md")
      ) {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      if (url.searchParams.get("list-type") === "2") {
        assert.equal(url.searchParams.get("prefix"), "company/okf/");
        if (!url.searchParams.has("continuation-token")) {
          return new Response(
            "<ListBucketResult>" +
              "<Contents><Key>company%2Fokf%2Fgood.md</Key><ETag>&quot;good&quot;</ETag><Size>55</Size></Contents>" +
              "<NextContinuationToken>next-page</NextContinuationToken>" +
              "</ListBucketResult>",
          );
        }
        return new Response(
          "<ListBucketResult>" +
            "<Contents><Key>company%2Fokf%2Fbad.md</Key><ETag>&quot;bad&quot;</ETag><Size>12</Size></Contents>" +
            "<Contents><Key>company%2Fokf%2Flarge.md</Key><ETag>&quot;large&quot;</ETag><Size>600000</Size></Contents>" +
            "<Contents><Key>company%2Fokf%2Findex.md</Key><ETag>&quot;index&quot;</ETag><Size>10</Size></Contents>" +
            "</ListBucketResult>",
        );
      }
      if (url.pathname.endsWith("/company/okf/good.md")) {
        return new Response(
          "---\ntype: Guide\ntitle: Shared guide\n---\n\n# Guide\n",
        );
      }
      if (url.pathname.endsWith("/company/okf/bad.md")) {
        return new Response("# Missing metadata\n");
      }
      return new Response("Not found", { status: 404 });
    },
  );
  try {
    const port = (server.addr as Deno.NetAddr).port;
    const first = await syncSharedSource({
      endpoint: `http://127.0.0.1:${port}`,
      bucket: "bundle",
      path: "company/okf",
      region: "us-east-1",
      accessKey: "access",
      secretKey: "secret",
    });
    assert.equal(first.files.length, 1);
    assert.equal(first.files[0].path, "good.md");
    assert.equal(first.files[0].title, "Shared guide");
    assert.deepEqual(
      first.issues.map((issue) => [issue.path, issue.error]),
      [
        ["bad.md", "Missing YAML frontmatter"],
        ["large.md", "File exceeds 512 KiB"],
      ],
    );
    assert.match(first.revision, /^[a-f0-9]{64}$/);
    const second = await syncSharedSource({
      endpoint: `http://127.0.0.1:${port}`,
      bucket: "bundle",
      path: "company/okf",
      region: "us-east-1",
      accessKey: "access",
      secretKey: "secret",
    });
    assert.equal(second.revision, first.revision);
    assert.equal(
      requests.some((url) =>
        url.searchParams.get("continuation-token") === "next-page"
      ),
      true,
    );
    assert.equal(
      requests.some((url) => url.pathname.endsWith("/large.md")),
      false,
    );
    await createObjectStore({
      endpoint: `http://127.0.0.1:${port}`,
      bucket: "bundle",
      region: "us-east-1",
      accessKey: "access",
      secretKey: "secret",
    }).remove("company/okf/good.md");
    assert.equal(deleted, true);
  } finally {
    await server.shutdown();
  }
});
