import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toPolicies } from "./policies.js";

describe("policies backward-compat re-export", () => {
  it("re-exports toPolicies from security", () => {
    assert.equal(typeof toPolicies, "function");
  });
});
