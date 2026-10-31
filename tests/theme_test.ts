/// <reference lib="deno.ns" />
/// <reference lib="dom" />
import assert from "node:assert/strict";
import { resolveTheme } from "../src/lib/theme.ts";

Deno.test("system follows the OS while light and dark are explicit", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});
