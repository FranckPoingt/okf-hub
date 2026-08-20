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

Working intent remains an OKF extension field. Consumers must tolerate unknown
fields, so `intent` does not weaken conformance.

# Imports

Git and S3-compatible sources accept arbitrary concept types and preserve the
original Markdown. A malformed concept is reported as a per-file issue without
blocking healthy concepts. Reserved `index.md` and `log.md` files are not
treated as concepts.

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
documents. Version 0.1.0 does not execute or attest `Attested Computation`
concepts; they remain readable concepts until a reviewed executor and attester
runtime is added.

[^okf-v0-2]: Open Knowledge Format specification v0.2.
