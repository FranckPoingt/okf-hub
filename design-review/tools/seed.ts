/// <reference lib="deno.ns" />
// Seeds the isolated `okf-design` stack with an "Acme" workspace for the
// design review. Run from the repository root on a fresh stack:
//   deno run -A design-review/tools/seed.ts
import { saveArtifact } from "../../scripts/save-artifact.ts";

const HUB = Deno.env.get("OKF_DESIGN_HUB") ?? "http://localhost:18788";
const DC = [
  "compose",
  "-p",
  "okf-design",
  "--env-file",
  ".env.okf-design",
  "-f",
  "compose.yaml",
  "-f",
  "design-review/tools/compose.design.yaml",
];
const PASSWORD = "acme-design-review";
const decoder = new TextDecoder();

async function docker(args: string[], input?: string) {
  const child = new Deno.Command("docker", {
    args: [...DC, ...args],
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const output = await child.output();
  const text = decoder.decode(output.stdout) + decoder.decode(output.stderr);
  if (!output.success) throw new Error(`docker ${args.join(" ")}\n${text}`);
  return text;
}

class Client {
  cookie = "";
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    if (init.body) headers.set("content-type", "application/json");
    headers.set("origin", HUB);
    const response = await fetch(`${HUB}${path}`, { ...init, headers });
    const cookie = response.headers.get("set-cookie")?.match(
      /better-auth\.session_token=[^;]+/,
    )?.[0];
    if (cookie) this.cookie = cookie;
    return response;
  }
  async send(path: string, body: unknown, method = "POST") {
    const response = await this.request(path, {
      method,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path} ${response.status}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }
}

const setup = (await docker(["logs", "app"])).match(/\?setup=([a-f0-9]+)/)
  ?.[1];
if (!setup) throw new Error("No setup link in the app logs; reset the stack");

const owner = new Client();
await owner.send("/api/auth/sign-up/email", {
  name: "Dana Whitfield",
  email: "dana@acme.test",
  password: PASSWORD,
  setupToken: setup,
});
await owner.send("/api/setup", {
  name: "Acme",
  tagline: "How Acme works, in one place",
});
for (
  const [name, email, access] of [
    ["Marcus Chen", "marcus@acme.test", "editor"],
    ["Priya Raman", "priya@acme.test", "viewer"],
  ]
) {
  const { id } = await owner.send("/api/invitations", { email, access });
  const member = new Client();
  await member.send("/api/auth/sign-up/email", {
    name,
    email,
    password: PASSWORD,
    invitationId: id,
  });
  await member.send("/api/invitations/accept", { invitationId: id });
}

const engineering = await owner.send("/api/spaces", { name: "Engineering" });
const support = await owner.send("/api/spaces", { name: "Customer Support" });
await owner.send("/api/spaces", { name: "Legal" });

type Seed = {
  title: string;
  type: string;
  space: string;
  body: string;
  publish?: boolean;
  draftAfterPublish?: string;
  reviewDue?: string;
  reviewed?: boolean;
  sources?: string[];
};

const docs: Seed[] = [
  {
    title: "Remote work policy",
    type: "Policy",
    space: "policies",
    publish: true,
    reviewed: true,
    reviewDue: "2027-03-01",
    body: `# Remote work policy

Acme is remote-first. Everyone can work from any country where we have a legal
entity, for up to 90 days a year from anywhere else.

## Core hours

Teams agree on at least **three overlapping hours** between 13:00 and 17:00
CET. Outside core hours, nobody is expected to reply to messages.

## Equipment

- A laptop chosen from the standard catalogue, replaced every three years.
- A one-off €600 home office budget, claimable through the expense tool.
- A monthly €40 internet allowance.

## Travel to offsites

Each team meets in person twice a year. See the [Expense policy](/knowledge/expense-policy)
for what travel costs are covered.
`,
  },
  {
    title: "Expense policy",
    type: "Policy",
    space: "policies",
    publish: true,
    reviewDue: "2026-08-15",
    body: `# Expense policy

Spend Acme's money as if it were your own, and keep the receipt.

## What you can claim

| Category | Limit | Approval |
| --- | --- | --- |
| Meals while travelling | €60 per day | None |
| Hotels | €180 per night | Manager |
| Training and books | €1,000 per year | Manager |
| Software | €25 per month | IT |

## How to claim

Submit claims within **30 days** with a photo of the receipt. Claims over
€500 need a short note explaining the business purpose.

> This policy was last reviewed before the 2026 travel budget changes.
`,
  },
  {
    title: "Security incident response",
    type: "Policy",
    space: "policies",
    publish: true,
    reviewed: true,
    reviewDue: "2027-01-15",
    body: `# Security incident response

Anyone who suspects a security incident reports it immediately in
#security-incidents or by calling the on-call security engineer.

## Severity levels

- **SEV1**: customer data exposed or production unavailable.
- **SEV2**: a vulnerability that is being actively exploited.
- **SEV3**: a vulnerability with no evidence of exploitation.

## First hour

1. The on-call engineer becomes incident lead.
2. The lead opens an incident channel and a timeline document.
3. Customer-facing teams are told what they can say, and when.
`,
    draftAfterPublish: `# Security incident response

Anyone who suspects a security incident reports it immediately in
#security-incidents or by calling the on-call security engineer. Reporting
something that turns out to be harmless is always welcome.

## Severity levels

- **SEV1**: customer data exposed or production unavailable for more than
  15 minutes.
- **SEV2**: a vulnerability that is being actively exploited.
- **SEV3**: a vulnerability with no evidence of exploitation.

## First hour

1. The on-call engineer becomes incident lead.
2. The lead opens an incident channel and a timeline document.
3. Legal is informed within one hour for any SEV1 involving personal data.
4. Customer-facing teams are told what they can say, and when.
`,
  },
  {
    title: "Parental leave",
    type: "Policy",
    space: "policies",
    body: `# Parental leave

Draft for the People team. All parents get **20 weeks** of fully paid leave,
which can be taken in up to three blocks during the first two years.

## Open questions

- Do we top up statutory pay in every country, or only where it is lower?
- How do we handle leave that spans a performance review cycle?
`,
  },
  {
    title: "Deploy freeze during billing migration",
    type: "Decision",
    space: engineering.id,
    publish: true,
    reviewed: true,
    reviewDue: "2027-02-01",
    body: `# Deploy freeze during billing migration

**Status:** accepted · **Date:** 12 September 2026 · **Deciders:** Platform team

## Context

The billing database moves to a new cluster during weeks 38 and 39. Deploys
that change billing tables during the copy would be lost.

## Decision

We freeze production deploys for billing and payments services during the
migration window. Other services deploy as usual.

## Consequences

- Hotfixes need approval from the migration lead.
- The weekly deploy count drops, which is expected.
`,
  },
  {
    title: "Use Postgres for the billing ledger",
    type: "Decision",
    space: engineering.id,
    publish: true,
    reviewed: true,
    reviewDue: "2027-04-01",
    sources: ["services/billing-api.md"],
    body: `# Use Postgres for the billing ledger

**Status:** accepted · **Date:** 3 June 2026

## Context

The ledger needs strict transactions, point-in-time recovery and
reporting queries that finance can read without an engineer.

## Decision

The billing ledger lives in Postgres 17, behind the Billing API. No other
service writes to ledger tables.

## Consequences

- Schema changes go through the Billing API repository and its review rules.
- Finance gets a read replica for reporting.
`,
  },
  {
    title: "On-call handbook",
    type: "Guide",
    space: engineering.id,
    publish: true,
    reviewed: true,
    reviewDue: "2027-01-10",
    body: `# On-call handbook

On-call engineers keep production healthy outside office hours. Rotations are
one week long, handed over on Monday at 10:00 CET.

## Before your shift

- Check that paging works on your phone.
- Read the handover notes from the previous engineer.
- Make sure you can reach the VPN and the runbooks.

## When you are paged

Acknowledge within **5 minutes**. If you cannot resolve the issue within 30
minutes, escalate to the secondary on-call engineer.

\`\`\`sh
okf runbook open payments-retry
\`\`\`
`,
  },
  {
    title: "Service level objective",
    type: "Glossary",
    space: engineering.id,
    publish: true,
    reviewed: true,
    reviewDue: "2027-05-01",
    body: `# Service level objective

A **service level objective (SLO)** is the target percentage of good events a
service aims for over a rolling 28-day window, for example 99.9% of API
requests answered successfully in under 300 ms.

An SLO is internal. The contractual promise to customers is the SLA, which is
always looser than the SLO.
`,
  },
  {
    title: "Local development setup",
    type: "Guide",
    space: engineering.id,
    body: `# Local development setup

Work in progress. This guide replaces the old wiki page.

1. Install Docker Desktop and Deno 2.
2. Clone the monorepo and run \`deno task dev\`.
3. Ask in #dev-help if the seed data fails to load.
`,
  },
  {
    title: "Refund",
    type: "Glossary",
    space: support.id,
    publish: true,
    reviewed: true,
    reviewDue: "2027-02-20",
    body: `# Refund

A **refund** returns money to the customer's original payment method. Support
can refund up to €200 without approval within 30 days of payment.

A refund is different from a **credit**, which reduces a future invoice and
never moves money back.
`,
  },
  {
    title: "Escalation guide",
    type: "Guide",
    space: support.id,
    publish: true,
    reviewed: true,
    reviewDue: "2027-01-31",
    body: `# Escalation guide

Escalate when a customer is blocked and you cannot unblock them within one
business day.

## Where to escalate

| Problem | Team | Channel |
| --- | --- | --- |
| Billing errors | Billing | #billing-escalations |
| Outage or data loss | On-call engineering | Page via the incident tool |
| Contract questions | Legal | legal@acme.test |

Always link the ticket and say what you have already tried.
`,
  },
  {
    title: "Customer data retention",
    type: "Decision",
    space: support.id,
    body: `# Customer data retention

**Status:** proposed

Support tickets are deleted 24 months after the account closes. Attachments
are deleted after 90 days unless they are part of an open dispute.
`,
  },
];

for (const doc of docs) {
  const created = await owner.send("/api/concepts", {
    title: doc.title,
    type: doc.type,
    intent: "canonical",
    spaceId: doc.space,
  });
  const markdown = doc.sources
    ? `---\nsources:\n${
      doc.sources.map((source) => `  - ${source}`).join("\n")
    }\n---\n\n${doc.body}`
    : doc.body;
  await owner.send(`/api/concepts/${created.id}`, markdown, "PUT");
  if (!doc.publish) continue;
  const published = await owner.send(`/api/concepts/${created.id}/publish`, {
    markdown,
  });
  if (doc.reviewed) {
    await owner.send(`/api/concepts/${created.id}/review`, {
      publishedRevision: published.publishedRevision,
      reviewDueDate: doc.reviewDue,
    });
  } else if (doc.reviewDue) {
    await owner.send(`/api/concepts/${created.id}/governance`, {
      reviewDueDate: doc.reviewDue,
    }, "PUT");
  }
  if (doc.draftAfterPublish) {
    await owner.send(
      `/api/concepts/${created.id}`,
      doc.draftAfterPublish,
      "PUT",
    );
  }
}

// A local Git source: an OKF folder whose concepts describe code paths.
const repo = "/tmp/handbook-work";
const sh = (script: string, input?: string) =>
  docker(["exec", "-T", "app", "sh", "-c", script], input);
await docker([
  "exec",
  "-T",
  "-u",
  "root",
  "app",
  "sh",
  "-c",
  "mkdir -p /seed && chown deno:deno /seed",
]);
await sh(
  `rm -rf /seed/handbook.git ${repo} && git init -q --bare -b main /seed/handbook.git && git init -q -b main ${repo}`,
);
const files: Record<string, string> = {
  "CODEOWNERS": "services/billing/ @acme/billing\nokf/ @acme/platform\n",
  "services/billing/schema.sql":
    "CREATE TABLE ledger_entry (id uuid PRIMARY KEY, amount_cents bigint NOT NULL);\n",
  "services/payments/retry.ts":
    "export const MAX_RETRIES = 3;\nexport const BACKOFF_MS = 2_000;\n",
  "okf/services/billing-api.md": `---
type: Service
title: Billing API
owner: "@acme/billing"
tags: [billing, ledger]
describes:
  - services/billing/**
---

# Billing API

The Billing API owns the ledger. It records every charge, refund and credit as
an immutable ledger entry, and is the only writer to ledger tables.
`,
  "okf/runbooks/payments-retry.md": `---
type: Runbook
title: Payments retry runbook
tags: [payments, on-call]
describes:
  - services/payments/retry.ts
---

# Payments retry runbook

Failed card payments are retried three times with a two-second backoff. If a
payment still fails, the customer is emailed and the invoice stays open.
`,
  "okf/glossary/service-level-objective.md": `---
type: Glossary
title: Service level objective
tags: [reliability]
---

# Service level objective

A service level objective is the availability target a team commits to for a
calendar month, for example 99.5% uptime measured by external probes.
`,
};
for (const [path, content] of Object.entries(files)) {
  await sh(
    `mkdir -p "$(dirname "$1")" && cat > "$1"`.replace(
      /\$1/g,
      `${repo}/${path}`,
    ),
    content,
  );
}
const commit = (message: string) =>
  sh(
    `cd ${repo} && git add -A && git -c user.name=Acme -c user.email=dev@acme.test commit -q -m "${message}" && git push -q /seed/handbook.git main`,
  );
await commit("Add handbook OKF folder");
const source = await owner.send("/api/sources/repositories", {
  repositoryUrl: "https://git.acme.test/acme/handbook.git",
  folder: "okf",
});
// Changing described code after the first sync marks Billing API stale, which
// cascades to the hub decision that lists it under `sources:`.
await sh(
  `cd ${repo} && printf 'ALTER TABLE ledger_entry ADD COLUMN currency text;\\n' >> services/billing/schema.sql`,
);
await commit("Add ledger currency");
await owner.send(`/api/sources/repositories/${source.id}/refresh`, {});

const key = await owner.send("/api/developer/keys", {
  name: "Design review seed",
  scopes: [
    "artifact.save",
    "spaces.list",
    "documents.create",
    "documents.get",
    "documents.update-draft",
    "documents.publish",
    "documents.trace.create",
    "apps.list",
    "apps.create",
    "apps.revise",
    "apps.activate",
  ],
});
Deno.env.set("OKF_HUB_TOKEN", key.token);
const artifacts = [
  ["examples/sovereign-artifact", "policies", "OKF Hub product direction"],
  [
    "design-review/tools/artifacts/calculator",
    support.id,
    "Support cost calculator",
  ],
  ["design-review/tools/artifacts/chart", engineering.id, "Deploys per week"],
];
for (const [folder, spaceId, title] of artifacts) {
  // Copy first: saving writes a receipt file next to the artifact.
  const copy = await Deno.makeTempDir();
  for await (const entry of Deno.readDir(folder)) {
    if (entry.isFile && !entry.name.startsWith(".")) {
      await Deno.copyFile(`${folder}/${entry.name}`, `${copy}/${entry.name}`);
    }
  }
  const saved = await saveArtifact({
    folder: copy,
    hubUrl: HUB,
    spaceId,
    title,
    publish: true,
  });
  console.log(`artifact ${title}: ${saved.documentUrl}`);
}

console.log(`Seeded ${HUB} — sign in as dana@acme.test / ${PASSWORD}`);
