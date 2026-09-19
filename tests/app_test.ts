/// <reference lib="deno.ns" />

import assert from "node:assert/strict";

Deno.test("builds the lifecycle and connected-source shell", async () => {
  const html = await Deno.readTextFile("dist/index.html");
  assert.match(html, /<title>OKF Hub — Portable company knowledge<\/title>/);

  const scripts: string[] = [];
  for await (const entry of Deno.readDir("dist/assets")) {
    if (entry.isFile && entry.name.endsWith(".js")) {
      scripts.push(await Deno.readTextFile(`dist/assets/${entry.name}`));
    }
  }
  const bundle = scripts.join("\n");
  assert.match(bundle, /Create your account/);
  assert.match(bundle, /Set up your workspace/);
  assert.match(bundle, /A workspace is only created when you finish this step/);
  assert.match(bundle, /Create workspace/);
  assert.match(bundle, /Members and groups/);
  assert.match(bundle, /Direct access/);
  assert.match(bundle, /View only/);
  assert.match(bundle, /Published revisions/);
  assert.match(bundle, /Select a published revision to see what changed/);
  assert.match(bundle, /Changes in revision/);
  assert.match(bundle, /Edit draft/);
  assert.match(bundle, /Publishing…/);
  assert.match(bundle, /Discuss the page or reply to a selected passage/);
  assert.match(bundle, /Comment on selection/);
  assert.match(bundle, /Resolve/);
  assert.match(bundle, /Reopen/);
  assert.match(bundle, /Collapse/);
  assert.match(bundle, /Restore concept/);
  assert.match(bundle, /Repository-owned OKF/);
  assert.match(bundle, /Refreshing…/);
  assert.match(bundle, /Private credentials stored/);
  assert.match(bundle, /Access token/);
  assert.match(bundle, /Disconnect repository/);
  assert.match(bundle, /Important changes are captured automatically/);
  assert.match(bundle, /Add context/);
  assert.match(bundle, /Fold lasting knowledge/);
  assert.match(bundle, /Maintained knowledge/);
  assert.match(bundle, /Shared controlled OKF/);
  assert.match(bundle, /Refresh shared store/);
  assert.match(bundle, /Connect and import/);
  assert.match(bundle, /Refresh Notion/);
  assert.match(bundle, /Notion owned/);
  assert.match(bundle, /Search company knowledge/);
  assert.match(bundle, /Advanced search and filters/);
  assert.match(bundle, /Search every source you can access/);
  assert.match(bundle, /Include archived/);
  assert.match(bundle, /Linked from/);
  assert.match(bundle, /Run checks now/);
  assert.match(bundle, /Fix broken link/);
  assert.match(bundle, /Source issues/);
  assert.match(bundle, /imported-document-header/);
  assert.match(bundle, /Shared-store owned/);
  assert.match(bundle, /Tools for this knowledge/);
  assert.match(bundle, /Answers from/);
  assert.match(bundle, /Create draft App/);
  assert.match(bundle, /Upload bundle/);
  assert.match(bundle, /Drop or paste an app folder/);
  assert.match(bundle, /Developer settings/);
  assert.match(bundle, /Developer API/);
  assert.match(bundle, /Loading API reference/);
  assert.match(bundle, /Allowed operations/);
  assert.match(bundle, /allow-scripts/);
  assert.match(bundle, /Workspace settings/);
  assert.match(bundle, /Export your data/);
  assert.match(bundle, /Entire workspace/);
  assert.match(bundle, /Download ZIP/);
  assert.match(bundle, /Connector settings/);
  assert.match(bundle, /Connector types/);
  assert.match(bundle, /Import source-owned knowledge/);
  assert.match(bundle, /Turn supported links into live previews/);
  assert.match(
    bundle,
    /Enable providers and configure how they import knowledge/,
  );
  assert.match(bundle, /New document/);
  assert.match(bundle, /Access comes from the selected space/);
  assert.match(bundle, /Template library/);
  assert.match(bundle, /built-in understanding brief/);
  assert.match(bundle, /Built-in/);
  const workspaceSettings = await Deno.readTextFile(
    "src/components/workspace-settings.tsx",
  );
  assert.match(workspaceSettings, /nextTemplateId === "understanding-brief"/);
  assert.match(workspaceSettings, /setDocumentType\("Explanation"\)/);
  assert.match(workspaceSettings, /setIntent\("working"\)/);
  assert.match(
    workspaceSettings,
    /canManageMembers && \([\s\S]*value="members"/,
  );
  assert.match(
    await Deno.readTextFile("src/App.tsx"),
    /canManageMembers=\{bootstrap\.access === "owner"\}/,
  );
  const developerPanel = await Deno.readTextFile(
    "src/components/developer-panel.tsx",
  );
  assert.match(developerPanel, /@scalar\/api-reference-react/);
  assert.match(developerPanel, /\/api\/openapi\.json/);
  assert.match(developerPanel, /withDefaultFonts: false/);
  assert.match(developerPanel, /telemetry: false/);
  assert.match(developerPanel, /showDeveloperTools: "never"/);
  assert.match(developerPanel, /agent: \{ disabled: true \}/);
  assert.match(developerPanel, /mcp: \{ disabled: true \}/);
  assert.match(developerPanel, /hideSearch: true/);
  assert.match(bundle, /Workspace identity/);
  assert.match(bundle, /New subdocument/);
  assert.match(bundle, /Document locked/);
  assert.match(bundle, /Choose where your OKF lives/);
  assert.match(bundle, /Render supported Miro board links/);
  assert.match(bundle, /Render supported spreadsheet links/);
  assert.match(
    bundle,
    /This connector applies automatically to supported links/,
  );
  assert.match(bundle, /Connect a source/);
  assert.match(bundle, /Create space/);
  assert.match(bundle, /Document settings/);
  assert.match(bundle, /Download OKF/);
  assert.match(bundle, /Manage spaces/);
  assert.match(bundle, /Moving a document keeps every draft/);
  assert.match(bundle, /Close presentation/);
  assert.match(bundle, /Next slide/);
  assert.match(bundle, /Pick up where you left off or find trusted knowledge/);
  assert.match(bundle, /No unpublished drafts/);
  assert.match(bundle, /Manage sources/);
  assert.match(bundle, /Knowledge page not found/);
  assert.match(bundle, /This knowledge page is unavailable/);
  assert.match(bundle, /popstate/);
  assert.doesNotMatch(
    await Deno.readTextFile("src/App.tsx"),
    /dangerouslySetInnerHTML/,
  );
  assert.doesNotMatch(
    await Deno.readTextFile("src/components/workspace-settings.tsx"),
    /TabsTrigger value="documents"/,
  );
  assert.doesNotMatch(
    await Deno.readTextFile("src/components/workspace-settings.tsx"),
    /<p className="eyebrow">OKF Hub<\/p>/,
  );
  assert.doesNotMatch(
    await Deno.readTextFile("src/components/editor/document-properties.tsx"),
    /updateFrontmatter|onMarkdownChange/,
  );
  assert.match(
    await Deno.readTextFile("src/App.tsx"),
    /item\.id === next\.id \? next : item/,
  );
  assert.match(
    await Deno.readTextFile("src/components/editor/document-editor.tsx"),
    /&epoch=\$\{collabEpoch\}/,
  );
  assert.match(
    await Deno.readTextFile("src/components/editor/document-editor.tsx"),
    /data-comment-thread/,
  );
  assert.match(
    await Deno.readTextFile("src/components/editor/document-editor.tsx"),
    /click: \(view, event\) => openThread\(view, event\)/,
  );
  assert.match(
    await Deno.readTextFile("src/App.tsx"),
    /setCommentAnchor\(commentSelection\.anchor\)/,
  );
  assert.match(
    await Deno.readTextFile("src/components/app-sidebar.tsx"),
    /className="pl-6"/,
  );
  const sidebar = await Deno.readTextFile("src/components/app-sidebar.tsx");
  assert.match(
    sidebar,
    /<SidebarMenuBadge>{sources\.length}<\/SidebarMenuBadge>/,
  );
  assert.match(sidebar, /expandedImportFolders/);
  assert.doesNotMatch(
    sidebar,
    /<SidebarMenuBadge>{imports\.length}<\/SidebarMenuBadge>/,
  );
  assert.match(
    await Deno.readTextFile("src/components/source-panels.tsx"),
    /className="source-documents"/,
  );
  assert.match(
    await Deno.readTextFile("src/collab-provider.ts"),
    /event\.code === 4009/,
  );
  assert.match(
    await Deno.readTextFile("src/lib/api.ts"),
    /globalThis\.location\.origin/,
  );
  assert.doesNotMatch(bundle, /Open spec/);
  assert.doesNotMatch(bundle, /Import \.md/);
  assert.doesNotMatch(
    await Deno.readTextFile("src/components/ui/command.tsx"),
    /InputGroup/,
  );
  assert.match(
    await Deno.readTextFile("src/App.tsx"),
    /setView\("published"\)/,
  );
  assert.match(
    await Deno.readTextFile("src/App.tsx"),
    /const spaceRouteVersion = spaces\.map[\s\S]*spaceRouteVersion,\n {2}\]\);/,
  );
});
