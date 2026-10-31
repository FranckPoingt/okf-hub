---
type: Reference
title: OKF v0.2 conformance
description: How OKF Hub produces, consumes, and exports conformant Open Knowledge Format bundles.
tags: [okf, interoperability, conformance]
status: stable
generated: { by: openai-codex/gpt-5, at: 2026-08-20T07:28:35Z }
sources:
  - id: okf-v0-2
    resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
    title: Open Knowledge Format specification v0.2
---

# Conformance target

OKF Hub targets the canonical Open Knowledge Format v0.2 specification.[^okf-v0-2]
The format is a directory tree of UTF-8 Markdown concept files with parseable
YAML frontmatter. Every concept has a non-empty `type`; `index.md` and `log.md`
are reserved for progressive disclosure and history.

# Hub-native documents

Publishing emits a concept document with:

- `type` and `title` from the document properties;
- `status: stable`;
- `generated.by` using the `human:<id>` actor convention;
- `generated.at` using the publication time;
- the canonical Markdown body.

Draft saves preserve `sources`, `describes`, `owner`, `tags`, `description`, and
unknown frontmatter fields. Body-only editor saves retain those fields. A save
containing frontmatter replaces the preserved fields; omitted fields are
removed. Published revisions and portable exports serialize them as YAML. The
Hub controls `type`, `title`, `id`, `status`, `generated`, and `intent`;
incoming frontmatter cannot override them. Sources can also be edited as a list
in document Properties, keeping dependency freshness tracking in sync. Existing
documents recover stored source references, but previously discarded citation
details and other fields must be supplied again.

Working intent remains an OKF extension field. Consumers must tolerate unknown
fields, so `intent` does not weaken conformance.

# Imports

Git and S3-compatible sources accept arbitrary concept types and preserve the
original Markdown. A malformed concept is reported as a per-file issue without
blocking healthy concepts. Reserved `index.md` and `log.md` files are not
treated as concepts.

# Extension fields

OKF consumers must tolerate unknown fields. OKF Hub reads these extensions on
imported concepts and hub documents; neither affects conformance:

- `describes`: a list of repository-relative globs naming the code a concept
  explains, using CODEOWNERS/gitignore syntax (`*` within a path segment, `**`
  across segments, a slash anchoring to the repository root, and a directory
  covering everything below it). When a Git sync changes a matching path but not
  the concept file, the concept's trust becomes `stale` until the concept is
  updated.
- `sources`: the standard OKF citation list. Entries whose `id` or `resource`
  names a hub document, an imported concept id, or an imported concept path are
  tracked as dependencies. A dependent document derives `stale` trust while any
  dependency is stale or missing.

Without an explicit `owner`, a Git-imported concept takes its owners from the
repository's `CODEOWNERS` rule for the concept file.

# Portable exports

Workspace and space ZIP exports contain an `okf/` bundle with a root `index.md`
declaring `okf_version: "0.2"`. Every exported concept has typed frontmatter:

- unchanged published content is `stable`;
- unpublished or changed draft content is `draft`;
- archived content is `deprecated`.

Sandboxed App files are exported beside the bundle under `apps/`. Keeping them
outside `okf/` prevents an App's arbitrary Markdown files from being mistaken
for concept documents.

# Current boundary

OKF Hub preserves unknown v0.2 fields and types in imported source-owned
documents. OKF Hub does not execute or attest `Attested Computation` concepts;
they remain readable concepts until a reviewed executor and attester runtime is
added.

[^okf-v0-2]: Open Knowledge Format specification v0.2.

# Cross-source references and shared entities

Cross-source references use ordinary Markdown links with a Hub-resolved URI:

```markdown
[Active customer](okf://repository/glossary/active-customer.md)
[Company policy](okf://hub/active-customer)
[Shared definition](okf://shared/glossary/active-customer.md)
[Notion definition](okf://notion/customer-page.md)
```

The authority is the source's stable identifier (source slug) from Sources or
`/api/sources`: `repository` for the first Git source, the assigned
`repository-<uuid>` for additional Git sources, `shared`, `notion`, or reserved
`hub` for native documents. Keep those identifiers consistent when moving a
bundle between Hub installations; they are not repository names or URLs. Native
paths use the document identifier, without `.md`. Imported paths are relative to
the bundle root, case-sensitive, with an optional `.md` suffix and
percent-encoded spaces. A `#fragment` is retained in the resolved URL. Queries,
traversal segments, credentials, and invalid encodings are rejected. Existing
relative and root-relative import links still resolve within their source;
`/knowledge/<id>` native links remain supported.

This is a Hub URI convention, not a new OKF syntax requirement or a promise that
other OKF consumers implement this scheme. The original label and URI remain in
portable Markdown and exports. Outside a resolver, readers still see the label
and destination and can read the surrounding definition. Inside the Hub, missing
and inaccessible destinations both render as plain label text; neither produces
a relationship or a distinction in the response. References can insert links to
any accessible source. Backlinks always exclude concepts the viewer cannot see.

A concept may declare an optional, non-empty string `id` in YAML frontmatter:

```yaml
---
type: Glossary
title: Active customer
id: company.customer.active
---
```

Use the same stable, case-sensitive ID for definitions of the same entity in
different sources, even if titles or types change. IDs group definitions; they
do not override the source/path URI destination or grant access. Hub-native
documents use their stable document identifier as the entity ID, and new
published revisions and workspace/space exports emit it as frontmatter `id`.
Imported frontmatter is preserved. Do not reuse an ID for unrelated entities.

The relationship view also groups matching `type` + `title` after Unicode NFKC
normalization, lowercasing, trimming, and collapsing whitespace. Both identity
rules are combined transitively; punctuation remains significant. “Also defined
in” lists definitions in other accessible sources, preserving their provenance.
There is no automatic merge or chosen canonical winner.

Potential conflicts use a lexical heuristic: remove a leading level-one title,
normalize case/Unicode, tokenize words and numbers, then compare multisets of
adjacent word pairs with Dice distance (`1 - 2 * overlap / total pairs`). A
distance **strictly greater than 0.35** flags a potential conflict. Empty
definitions compare equal to each other and different from non-empty
definitions. Unavailable bodies are not compared. Formatting-only differences
are ignored, but paraphrases can produce false positives and small semantic
changes can be missed. The signal is a review prompt, not a semantic or factual
verdict. No AI provider is required, and no source content is edited. Readers
see published native content; editors' graph uses the drafts they may edit.
Grouping, comparison, backlinks, and counts all run on the viewer's accessible
inventory, before search text/type/tag filters.
