# Third-party notices

## Prismatic Components

The Notion source adapter in `server/notion-source.ts` is adapted from API and
authentication patterns in the Prismatic Notion component.

- Source:
  <https://github.com/prismatic-io/components/tree/main/components/notion>
- License: Apache License 2.0
- Changes: removed the Prismatic Spectral runtime and action model; adapted the
  read path to Deno, `fetch`, and OKF Hub's read-only snapshot contract.

Copyright remains with the original contributors. The Apache License 2.0 is
available at <https://www.apache.org/licenses/LICENSE-2.0>.
