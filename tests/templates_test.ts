/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { renderTemplate, templateVariables } from "../src/lib/templates.ts";

Deno.test("template preview and creation share variable parsing", () => {
  const body =
    "Hello {{ team }} and {{Owner_name}}. {{team}} again. {{bad-name}} stays literal.";
  assert.deepEqual(templateVariables(body), ["team", "Owner_name"]);
  assert.deepEqual(
    renderTemplate(body, { team: "Support", Owner_name: "Sam" }),
    {
      body: "Hello Support and Sam. Support again. {{bad-name}} stays literal.",
    },
  );
  assert.deepEqual(templateVariables(body), ["team", "Owner_name"]);
});

Deno.test("template rendering rejects missing, blank, and inherited values", () => {
  const body = "{{ owner }} and {{team}}";
  for (
    const values of [{ team: "Support" }, { owner: " ", team: "Support" }, {
      owner: 2,
      team: "Support",
    }]
  ) {
    assert.deepEqual(renderTemplate(body, values), {
      error: values.team ? "Fill in owner" : "Fill in owner, team",
    });
  }
  assert.deepEqual(
    renderTemplate(body, Object.create({ owner: "Sam", team: "Support" })),
    { error: "Fill in owner, team" },
  );
  assert.deepEqual(renderTemplate("{{toString}}", {}), {
    error: "Fill in toString",
  });
});

Deno.test("template replacement preserves literal user text", () => {
  assert.deepEqual(
    renderTemplate("{{ value }} / {{value}}", { value: "$& {{other}}" }),
    {
      body: "$& {{other}} / $& {{other}}",
    },
  );
  assert.deepEqual(renderTemplate("## Plain outline", {}), {
    body: "## Plain outline",
  });
});
