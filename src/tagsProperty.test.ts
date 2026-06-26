import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { getStandardTags, MANAGED_BY_TAG_VALUE } from "./tags.js";

/**
 * Feature: bootstrap-enhancements, Property 1: Tag generation produces correct structure and content
 *
 * For any non-empty string `purpose` with length between 1 and 64 characters,
 * calling `getStandardTags(purpose)` returns an array of exactly 2 elements
 * where the first has Key: "ManagedBy" and Value: "beesolve-aws-accounts",
 * and the second has Key: "Purpose" and Value equal to the provided purpose string.
 *
 * **Validates: Requirements 1.4, 4.1, 4.3**
 */
test("Feature: bootstrap-enhancements, Property 1: Tag generation produces correct structure and content", () => {
  const purposeArb = fc.string({ minLength: 1, maxLength: 64 });

  fc.assert(
    fc.property(purposeArb, (purpose) => {
      const tags = getStandardTags(purpose);

      // Returns exactly 2 elements
      assert.equal(tags.length, 2);

      // First tag is ManagedBy with the constant value
      assert.equal(tags[0].Key, "ManagedBy");
      assert.equal(tags[0].Value, MANAGED_BY_TAG_VALUE);
      assert.equal(tags[0].Value, "beesolve-aws-accounts");

      // Second tag is Purpose with the provided purpose string
      assert.equal(tags[1].Key, "Purpose");
      assert.equal(tags[1].Value, purpose);
    }),
    { numRuns: 100 },
  );
});
