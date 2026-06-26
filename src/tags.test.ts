import assert from "node:assert/strict";
import test from "node:test";

import { getStandardTags, MANAGED_BY_TAG_VALUE } from "./tags.js";

test("MANAGED_BY_TAG_VALUE is beesolve-aws-accounts", () => {
  assert.equal(MANAGED_BY_TAG_VALUE, "beesolve-aws-accounts");
});

test("getStandardTags returns correct tags for a given purpose", () => {
  const tags = getStandardTags("state-storage");
  assert.deepEqual(tags, [
    { Key: "ManagedBy", Value: "beesolve-aws-accounts" },
    { Key: "Purpose", Value: "state-storage" },
  ]);
});

test("getStandardTags throws on empty purpose", () => {
  assert.throws(() => getStandardTags(""), { message: "A non-empty purpose is required" });
});

test("getStandardTags returns exactly 2 tags", () => {
  const tags = getStandardTags("graveyard");
  assert.equal(tags.length, 2);
});
