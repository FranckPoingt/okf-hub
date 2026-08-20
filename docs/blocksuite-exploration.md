---
type: Decision
title: BlockSuite exploration for OKF Hub
description: Defer BlockSuite until a separate canvas proves necessary without replacing canonical Markdown.
tags: [okf-hub, blocksuite, canvas, editor]
status: draft
---

# BlockSuite exploration for OKF Hub

Status: explore later; do not replace Milkdown now.

## Decision

BlockSuite is promising for a future AFFiNE-style canvas view, but it should not
become OKF Hub's document editor yet. The current Markdown + Milkdown + Yjs path
already gives the hub a portable canonical format, collaboration, publishing,
and source interoperability. Replacing it now would introduce a second document
model before the product has proved that a visual canvas is essential.

The first worthwhile experiment is an optional **Canvas** surface for one
concept. It should reference hub pages and artifacts while Markdown remains
authoritative. Do not run PageEditor and Milkdown as peer authorities over the
same document.

## Why it is interesting

BlockSuite exposes `PageEditor` and `EdgelessEditor` as native web components,
and the same BlockSuite document can be attached to either editor. Edgeless
includes shapes, connectors, frames, presentation mode, link cards, rich text,
collaboration, and per-user undo/redo. That is close to the strongest part of
AFFiNE's UX: moving between structured writing and spatial thinking without
exporting to another tool.

Its store is built on Yjs. Each document is a block tree backed by a Yjs
subdocument, while `DocCollection` coordinates multiple documents. BlockSuite
also provides snapshots and adapters for formats including Markdown and HTML.

Sources:

- [BlockSuite repository and architecture](https://github.com/toeverything/blocksuite)
- [Edgeless Editor](https://blocksuite.io/components/editors/edgeless-editor)
- [BlockSuite store and Yjs model](https://blocksuite.io/guide/store)
- [Data synchronization, snapshots, and adapters](https://blocksuite.io/guide/data-synchronization)
- [React integration quick start](https://blocksuite.io/guide/quick-start)

## Fit with the current architecture

| Concern            | Current OKF Hub                               | BlockSuite implication                                                  |
| ------------------ | --------------------------------------------- | ----------------------------------------------------------------------- |
| Canonical content  | Markdown                                      | Block tree / CRDT binary is primary; Markdown is an adapter format      |
| Editor             | Milkdown / ProseMirror                        | Native web-component PageEditor and EdgelessEditor                      |
| Collaboration      | Existing Yjs document and provider            | BlockSuite owns its own Yjs-backed document structure                   |
| Publishing         | Explicit Markdown revisions                   | Needs a defined block snapshot plus deterministic Markdown export       |
| Imported knowledge | Read-only Markdown from authoritative sources | Must remain outside BlockSuite ownership                                |
| Permissions        | Concept and space checks on every API path    | Canvas data must use the same concept boundary                          |
| Artifacts          | Separate reviewed, sandboxed runtime          | Canvas should reference artifacts, never absorb their executable source |

The shared use of Yjs does not make the models interchangeable. Milkdown
synchronizes a ProseMirror document; BlockSuite synchronizes its own typed block
tree and surface elements. Bridging both live would create duplicate state and
conflict semantics.

## Main risks

1. **Markdown fidelity.** BlockSuite supports Markdown adapters, but custom
   blocks, canvas geometry, embeds, and some rich structure cannot round-trip
   through plain Markdown without an extension format.
2. **Two sources of truth.** A PageEditor replacement would move the canonical
   model from Markdown to BlockSuite. A side-by-side live editor would be worse
   because both would mutate different Yjs structures.
3. **Maturity and churn.** The project describes itself as early-stage and the
   quick start recommends canary packages released from the main branch. Pinning
   and upgrade testing would be mandatory.
4. **Integration surface.** Web components work in React, but selection,
   commands, styling, focus handling, and accessibility still cross a framework
   boundary.
5. **Payload and performance.** The presets bring a substantial editing and
   canvas stack. Measure cold load, interaction latency, and memory on realistic
   documents before adoption.
6. **Licensing.** BlockSuite is MPL-2.0. A production spike needs a dependency
   and modification-boundary review, especially if framework files are changed
   rather than consumed as packages.

## Smallest useful spike

Build the spike only when users need spatial knowledge work that links at least
three existing concepts or artifacts.

1. Add a separate `Canvas` document surface behind a local feature flag.
2. Use one BlockSuite `EdgelessEditor` with its own persisted snapshot keyed by
   concept ID.
3. Support only text notes, connectors, and read-only reference cards to hub
   concepts or live artifacts.
4. Keep the concept's Markdown document unchanged and canonical.
5. Reuse the existing concept permission check and collaboration transport
   boundary; do not expose a second unauthorised persistence endpoint.
6. Test two collaborators, reload recovery, export/import, a 500-object canvas,
   keyboard navigation, mobile read access, and package size.

## Adoption gates

Adopt the optional Canvas surface only if the spike demonstrates all of the
following:

- no loss or mutation of canonical Markdown;
- reference cards obey permission filtering and broken-link behavior;
- collaboration and reload recovery are reliable with the existing backend;
- the added editor loads on demand and does not slow normal document opening;
- keyboard and screen-reader paths cover the supported canvas actions;
- the pinned release has an acceptable upgrade and security-maintenance story.

Consider replacing Milkdown only after the product deliberately chooses
BlockSuite's block model—not Markdown—as the canonical format. That is an
architecture migration, not a UI component swap.
