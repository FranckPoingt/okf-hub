/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { embedPreview, enableEmbedConnectors } from "../src/lib/embeds.ts";

Deno.test("turns portable Miro and Google Sheets links into safe previews", () => {
  assert.equal(
    embedPreview(
      "https://miro.com/app/board/uX_example=/?moveToWidget=123",
    )?.href,
    "https://miro.com/app/live-embed/uX_example=/?moveToWidget=123&embedMode=view_only_without_ui&autoplay=true",
  );
  assert.equal(
    embedPreview(
      "https://docs.google.com/spreadsheets/d/sheet-id/edit?gid=2#gid=2",
    )?.href,
    "https://docs.google.com/spreadsheets/d/sheet-id/preview?gid=2#gid=2",
  );
  assert.equal(
    embedPreview(
      "https://docs.google.com/spreadsheets/d/e/public-id/pubhtml?widget=true",
    )?.href,
    "https://docs.google.com/spreadsheets/d/e/public-id/pubhtml?widget=true",
  );
  assert.equal(embedPreview("http://miro.com/app/board/example"), null);
  assert.equal(
    embedPreview("https://miro.com.example/app/board/example"),
    null,
  );
  assert.equal(embedPreview("https://example.com"), null);
  enableEmbedConnectors(["google-sheets"]);
  assert.equal(embedPreview("https://miro.com/app/board/example"), null);
  assert.equal(
    embedPreview("https://docs.google.com/spreadsheets/d/sheet-id/edit")
      ?.provider,
    "google-sheets",
  );
  enableEmbedConnectors(["miro", "google-sheets"]);
});
