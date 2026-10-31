# OKF Hub design review

Review of the UI at `99b0be3`, taken from real screenshots of a seeded stack,
followed by a focused polish pass on this branch.

- **Before:** `design-review/before/` (production Docker build of `99b0be3`)
- **After:** `design-review/after/` (production Docker build of `d969662`)
- File names are `<screen>-<desktop|mobile>-<light|dark>.png`. Desktop is
  1440×900 and mobile is 390×844.
- 22 screens × 4 variants = 88 shots per set. The PNGs are palette-compressed.

## Overall rating

|             | Before     | After      |
| ----------- | ---------- | ---------- |
| Light mode  | 5.5 / 10   | 7.5 / 10   |
| Dark mode   | 2 / 10     | 7 / 10     |
| **Overall** | **4 / 10** | **7 / 10** |

**Before.** The information architecture is sound. Navigation, spaces, trust
signals, provenance and the artifact-first view are all in sensible places, and
the light theme has a pleasant, calm paper-and-green identity. The craft is
uneven, though, and it shows where the three builds meet. Three separate systems
are layered on top of each other:

- legacy px-based page CSS (Georgia headings, 8–10px labels, hard-coded hex
  colors)
- shadcn/Tailwind components
- Milkdown Crepe and Scalar themes that were never mapped to the app's tokens

The most damaging result is a 14px root font size that silently shrank every
rem-based size, so most secondary text was 10.5px. Dark mode looked unfinished:
it used a generic neutral and indigo palette, many surfaces stayed light, and
document headings, diffs and tabs were dark-on-dark. Status language was
inconsistent: "stale" in red lowercase, "current" in grey lowercase, "Activated
· v1" in one place and "Live · v1" in another, and "Reviewed" and "Not
published" looked identical.

**After.** The same screens now read as one product. Text is at the scale the
components were designed for. Every status uses one vocabulary and one color
meaning. Dark mode is a coherent branded theme. All measured text passes WCAG
AA, and keyboard focus is clearly visible. What still holds the score back is
listed in [Issues left](#issues-left): the crowded document header, mobile
document toolbars, the stale reason being hidden in a tooltip, and the size of
the legacy CSS.

## Method

1. **Seed.** `design-review/tools/seed.ts` creates the following on a fresh
   `okf-design` stack:
   - **Acme workspace** with 3 populated spaces and one empty space (Legal).
   - **Documents:** 12 hub documents (policies, glossary entries, guides and
     decisions). Most are published; there are 3 drafts, 1 overdue review and 1
     published document with pending draft changes.
   - **Artifacts:** `examples/sovereign-artifact`, plus a calculator and a chart
     (classic scripts, no network access).
   - **Local Git source:** an `okf/` folder whose `describes:` globs cover
     service code. A second commit changes `services/billing/schema.sql`. This
     makes _Billing API_ stale, and the staleness cascades to the hub decision
     that lists it under `sources:`. The source's glossary entry also creates an
     "Also defined in" conflict with the hub's _Service level objective_.
   - **Users:** owner (Dana), editor (Marcus) and viewer (Priya).
2. **Capture.** `design-review/tools/shoot.mjs` uses Playwright/Chromium.
   - The app has no theme switch, so dark mode is captured by adding `.dark` to
     `<html>`.
   - The first-run setup screen is captured by mocking `/api/bootstrap`, so the
     same script works against a seeded stack.
3. **Measure.** Ad-hoc Playwright audits (not committed) cover 13 key pages in
   light and dark:
   - contrast of every visible text node against its composited background (WCAG
     AA: 4.5:1, or 3:1 for large text)
   - text smaller than 12px
   - unlabeled controls
   - keyboard focus: tabbing 36–45 stops per page and comparing focused and
     blurred styles

| Metric (13 pages, deduplicated per page) |                                                                                                             Before |                                                    After |
| ---------------------------------------- | -----------------------------------------------------------------------------------------------------------------: | -------------------------------------------------------: |
| Text below WCAG AA, light                |                                                                                                                226 |                                                    **0** |
| Text below WCAG AA, dark                 |                                                                             45 (plus invisible headings and diffs) |                                                    **0** |
| Text nodes under 12px                    |                                                                                                      307 per theme | 41 (deliberate 11px uppercase eyebrows and field labels) |
| Focus indicator contrast                 |                                                                                  coral at 35% opacity, about 1.5:1 |                    2px `--ring`: 4.4:1 light, 5.8:1 dark |
| Tab stops without any focus change       |                                                                                                                  0 |                                                        0 |
| Unlabeled controls                       | 9 on 3 pages; all hidden Base UI form proxies or `opacity-0` checkbox inputs with visible labels (false positives) |                                                     same |

## Top issues, ranked by impact (before)

### 1. The type scale was shrunk globally (typography, readability)

`html, body { font-size: 14px }` made `1rem = 14px`. Tailwind's scale and the
legacy rem rules were written for 16px, so `text-xs` rendered at 10.5px and
`text-sm` at 12.25px. Badges, sidebar labels, metadata and tabs were all
undersized, and on top of that, 16 live legacy rules used 8–10px. The sidebar's
space names ended up larger than its items, which inverted the hierarchy.

See `home-desktop-light.png`, `sources-desktop-light.png` and
`document-published-desktop-light.png`. In the before shots, compare the badge
text and tab labels.

### 2. Dark mode was broken (dark-mode defects, contrast)

- **Palette.** `.dark` was the stock shadcn palette: neutral grays and an indigo
  `--sidebar-primary`, so the Create button turned blue.
- **Missing tokens.** `.dark` never defined `--muted-surface`, `--ink`,
  `--paper` or `--line`, which the legacy CSS depends on.
- **Hard-coded colors.** 115 declarations used light hex values, so view
  switches, kbd hints, inputs on the auth screen and avatar fallbacks stayed
  white or light.
- **Third-party themes.** Milkdown Crepe kept its own black-on-white variables,
  so document `h2`s measured 1.25:1, the draft-review diff body was nearly
  invisible and in-prose links were dark-on-dark. The Scalar API reference
  stayed white because Scalar puts `light-mode` on `<body>`, which outranked the
  app's `:root` overrides.

See `draft-review-desktop-dark.png`, `document-published-desktop-dark.png`,
`developer-api-desktop-dark.png` and `signin-desktop-dark.png`.

### 3. Status language was inconsistent (badge and status vocabulary)

| Signal              | Where                     | Before                                                                             |
| ------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| Trust               | search, header, gallery   | `stale`, `sync failed`: lowercase, red (same tone as an error)                     |
| Source status       | Sources, Connectors       | `current`: lowercase, grey outline in one place and secondary in another           |
| Sync and automation | Sync history, Sync health | raw `succeeded` / `failed`, or colored bold text                                   |
| Freshness           | everywhere                | "Reviewed" and "Not published" both outline; "Needs review" secondary; overdue red |
| Artifact            | header, aside, gallery    | "Activated · v1" (filled dark pill) vs "Live · v1" (10px pill) for the same state  |
| Revision            | history                   | "Reviewed" outline                                                                 |
| Conflict            | search                    | "Potential conflict" in destructive red                                            |

Red meant both "broken" and "needs a look", and green was never used for healthy
states. See `search-results-*`, `sources-*`, `artifact-first-*` and
`artifact-gallery-*`.

### 4. Typography families were mixed (visual hierarchy)

Document headings, artifact gallery card titles, empty-state titles and
work-trace headings fell back to Times/Georgia. The cause was Crepe's default
`--crepe-font-title: 'Noto Serif'` plus 15 legacy `Georgia` rules, all sitting
under heavy sans page titles. Page titles themselves came in three treatments:
30px/600 (Home, Spaces, Artifacts), 36px/680 (Search, Sources) and 28–36px/400
(Settings, Developer). See `document-published-desktop-light.png`,
`artifact-gallery-desktop-light.png`, `settings-members-desktop-light.png` and
`developer-api-desktop-light.png`.

### 5. Contrast was below AA in light mode (color, contrast)

- `--muted-foreground` measured 4.38:1 on paper.
- Sidebar secondary text (`/60`, `/70` opacity) measured 3.2–4.1:1.
- Inactive tabs (`text-foreground/60`) measured 4.25:1.
- Trust badges measured 3.5–3.8:1.
- A legacy `.imported-document-location > span` rule recolored a Stale badge to
  grey.
- A viewer sees the document title at 50% opacity because the read-only title is
  a `disabled` textarea (`document-published-desktop-light.png`, viewer).

### 6. The keyboard focus indicator was too faint (accessibility)

The global `button:focus-visible, a:focus-visible` outline was coral at 35%
opacity, roughly 1.5:1 against the page, below the 3:1 non-text minimum.
`summary` accordions and focusable badges relied on it too.

### 7. Empty states were inconsistent

The artifact gallery had a good empty state (icon, title, guidance, action). The
empty space had a single bold line inside a card, and search had a single grey
line. See `space-empty-*` and `search-empty-*`.

### 8. Mobile layout and header crowding

- Search result badges overflowed the card on mobile because the title `Button`
  inherits `shrink-0` (`search-results-mobile-light.png`).
- The header's page-context text ("Permission Filtered · Authorised results")
  truncated on every mobile page.
- On the setup screen, "Already have an account? Sign in" was a second filled
  primary button, because it was missing `variant="link"` (`setup-*`).
- The search heading's Ask OKF button had no spacing.

### 9. Loading states (evaluated lightly)

The visible loading states are plain text: "Connecting to document…", "Loading
API reference…" and "Checking access…". They are adequate, and no
layout-shifting spinners were seen. No skeletons are used even though
`ui/skeleton.tsx` exists. This was not changed.

## What changed

Seven commits, one per theme. `deno fmt` and `deno task test` passed before each
one (134 tests: the 133 existing plus 1 new).

| Commit    | Theme                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b4339d9` | **Type scale.** 16px root and 14px body; live 8–10px rules raised to 11–12px; read-only titles no longer dimmed; mobile search titles shrink so badges fit.                                                                                                                                                                                                                               |
| `d93a8f0` | **Status vocabulary.** `Badge` gains `success` and `warning` tones, backed by `--success` and `--warning` tokens that pass AA on their own tint. A `StatusBadge` and `src/lib/status.ts` map every machine state to one sentence-case label and tone. Trust, source, sync, automation, artifact and freshness badges all use it, and "Activated" becomes "Live". A unit test is included. |
| `65ecb63` | **Tokens and dark mode.** 115 hard-coded colors now use tokens. `.dark` gets a green-tinted brand palette (text ≥ 6.5:1, primary 8.8:1) plus the legacy aliases. Crepe and Scalar are mapped to the same tokens. One `--font-ui` token replaces Georgia and Times everywhere except the logo mark. AA fixes cover muted text, sidebar text and tabs.                                      |
| `f11c6b9` | **Focus.** A solid 2px `--ring` outline for buttons, links, `summary`, tabs and `[tabindex]`.                                                                                                                                                                                                                                                                                             |
| `8a74369` | **Hierarchy.** One page-title style; the auth toggle is a link; the redundant header status is hidden on mobile non-document pages; Ask OKF spacing on Search.                                                                                                                                                                                                                            |
| `d6f8819` | **Empty states.** A shared `EmptyState`, used for spaces, search and the artifact gallery.                                                                                                                                                                                                                                                                                                |
| `d969662` | **Imported header.** Badges keep their tone in the imported-document header.                                                                                                                                                                                                                                                                                                              |

No information architecture, behavior or dependency changes. Copy changes are
limited to status labels ("Live" instead of "Activated", sentence case) and the
two new empty-state descriptions.

## Before / after

| Screen                      | Before                                               | After                                               | What to look for                                                       |
| --------------------------- | ---------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| Home                        | [light](before/home-desktop-light.png)               | [light](after/home-desktop-light.png)               | Readable sidebar and tabs; green "Reviewed" vs neutral "Needs review". |
| Home, dark                  | [dark](before/home-desktop-dark.png)                 | [dark](after/home-desktop-dark.png)                 | Brand palette instead of black and indigo; kbd hint no longer white.   |
| Published document (viewer) | [light](before/document-published-desktop-light.png) | [light](after/document-published-desktop-light.png) | Full-strength title; sans headings.                                    |
| Published document, dark    | [dark](before/document-published-desktop-dark.png)   | [dark](after/document-published-desktop-dark.png)   | Headings and links legible (1.25:1 before).                            |
| Draft review, dark          | [dark](before/draft-review-desktop-dark.png)         | [dark](after/draft-review-desktop-dark.png)         | Diff body legible.                                                     |
| Stale cascade               | [light](before/document-stale-desktop-light.png)     | [light](after/document-stale-desktop-light.png)     | Amber "Stale" in the header.                                           |
| Search results              | [light](before/search-results-desktop-light.png)     | [light](after/search-results-desktop-light.png)     | Amber Stale and green Reviewed; Ask OKF spacing.                       |
| Search, mobile              | [mobile](before/search-results-mobile-light.png)     | [mobile](after/search-results-mobile-light.png)     | Badges wrap inside the card; header no longer truncates.               |
| Imported concept            | [light](before/imported-concept-desktop-light.png)   | [light](after/imported-concept-desktop-light.png)   | Stale badge in tone (3.5:1 before).                                    |
| Artifact-first and context  | [light](before/artifact-first-desktop-light.png)     | [light](after/artifact-first-desktop-light.png)     | "Live · v1" in both places; sans context headings.                     |
| Artifact gallery            | [light](before/artifact-gallery-desktop-light.png)   | [light](after/artifact-gallery-desktop-light.png)   | Sans card titles; Live badge at normal size.                           |
| Sources                     | [light](before/sources-desktop-light.png)            | [light](after/sources-desktop-light.png)            | "Current" in success green; consistent title.                          |
| Source access               | [light](before/source-access-desktop-light.png)      | [light](after/source-access-desktop-light.png)      | Scale and title.                                                       |
| Settings: members           | [light](before/settings-members-desktop-light.png)   | [light](after/settings-members-desktop-light.png)   | Title matches other pages.                                             |
| Developer API, dark         | [dark](before/developer-api-desktop-dark.png)        | [dark](after/developer-api-desktop-dark.png)        | Scalar follows the theme.                                              |
| Setup                       | [light](before/setup-desktop-light.png)              | [light](after/setup-desktop-light.png)              | One primary action; the sign-in toggle is a link.                      |
| Sign in, dark               | [dark](before/signin-desktop-dark.png)               | [dark](after/signin-desktop-dark.png)               | Dark inputs; visible brand name.                                       |
| Empty space                 | [light](before/space-empty-desktop-light.png)        | [light](after/space-empty-desktop-light.png)        | Shared empty state.                                                    |
| No search results           | [light](before/search-empty-desktop-light.png)       | [light](after/search-empty-desktop-light.png)       | Shared empty state.                                                    |
| Ask OKF (unavailable)       | [light](before/ask-unavailable-desktop-light.png)    | [light](after/ask-unavailable-desktop-light.png)    | Unchanged apart from scale and tokens.                                 |

> Data note: opening an API-created document in the editor strips a leading
> `# Title` that duplicates the title field and saves it as a draft change (see
> Issues left). Because the capture script opens documents in the editor,
> several documents show "Draft changes" in shots taken after that point. This
> is data drift, not a design change.

## Issues left

Ranked by impact, with the reason each was left.

1. **The document header is overloaded at 1440px.** It holds the breadcrumb,
   Search, status, view switch, Ask OKF, presence, comments, link, Stale,
   Draft/Published, save state, Review changes, Publish and a menu. The
   breadcrumb collapses to "›" on wide screens
   (`document-stale-desktop-light.png`). Fixing it means deciding which actions
   move into the menu, which is an information-architecture change and out of
   scope.
2. **Mobile document toolbars are icon-only and dense**, and the conflict card's
   "Compare with" and "Also defined in" chips clip on mobile
   (`document-conflict-mobile-*`). Same reason: it needs an interaction decision
   about what collapses.
3. **The stale reason is only in a tooltip.** A stale hub document shows a small
   badge in the header, and the "Depends on services/billing-api.md: described
   code changed…" explanation needs a hover or focus. An inline alert would be
   clearer, but it is a new UI element, so it is out of scope for a polish pass.
4. **Dark mode is not reachable.** Nothing sets `.dark`: there is no toggle and
   no `prefers-color-scheme`. Dark mode is now ready to switch on, but adding
   the switch is a feature.
5. **The editor normalizes API-created documents.** A leading `# Title` that
   matches the title field is stripped on open and saved as a draft change, so
   documents created through the API or MCP gain unexplained "Draft changes"
   when someone opens them. This is behavior; reported, not changed.
6. **Legacy CSS debt.** `styles.css` still has roughly 30 rules for class names
   no longer used in `src`, plus `!important` overrides that re-assert shadcn
   button variants over legacy page selectors. Deleting rules without per-class
   verification risks regressions for little visual gain.
7. **The header status is jargon.** "Permission Filtered", "Hub Management" and
   "Connected Sources" are rendered with `capitalize`. It is now hidden on
   mobile, but the wording needs a product decision.
8. **Eyebrows and source-form field labels are 11px.** These are deliberate,
   letter-spaced uppercase labels that pass contrast. Raising them is a taste
   call.
9. **The amber Stale tint is subtle in light mode.** It is AA-compliant text on
   a 10% tint and reads brownish at small sizes. A stronger tint or a border
   would make it pop, but that is cosmetic.
10. **Loading states are text-only** (see issue 9 in the ranked list above).
    Adequate, not polished.

## Reproduce

The commands below run from the repository root, against a separate Compose
project on port 18788. The `-f` flags put
`design-review/tools/compose.design.yaml` on top of `compose.yaml`.

```sh
# .env.okf-design (gitignored by .env*) needs the four secrets from compose.yaml plus:
#   OKF_APP_BIND=127.0.0.1:18788:8788
#   OKF_BASE_URL=http://localhost:18788
DC="docker compose -p okf-design --env-file .env.okf-design -f compose.yaml -f design-review/tools/compose.design.yaml"
$DC up -d --build --wait
deno run -A design-review/tools/seed.ts          # fresh stack only
NODE_PATH=/path/to/playwright/node_modules node design-review/tools/shoot.mjs design-review/after
$DC down -v --rmi local
```
