import assert from "node:assert/strict";
import test from "node:test";

import {
  isJsonRecord,
  renderPicklistSchema,
  renderTsValue,
  sortJsonRecord,
} from "./awsConfigRender.js";

test("renderTsValue renders null", () => {
  assert.equal(renderTsValue(null, { indentLevel: 0, withinInlinePolicy: false }), "null");
});

test("renderTsValue renders strings as JSON", () => {
  assert.equal(renderTsValue("hello", { indentLevel: 0, withinInlinePolicy: false }), '"hello"');
});

test("renderTsValue renders numbers", () => {
  assert.equal(renderTsValue(42, { indentLevel: 0, withinInlinePolicy: false }), "42");
});

test("renderTsValue renders booleans", () => {
  assert.equal(renderTsValue(true, { indentLevel: 0, withinInlinePolicy: false }), "true");
});

test("renderTsValue renders empty array", () => {
  assert.equal(renderTsValue([], { indentLevel: 0, withinInlinePolicy: false }), "[]");
});

test("renderTsValue renders empty object", () => {
  assert.equal(renderTsValue({}, { indentLevel: 0, withinInlinePolicy: false }), "{}");
});

test("renderTsValue renders array with items", () => {
  const result = renderTsValue(["a", "b"], { indentLevel: 0, withinInlinePolicy: false });
  assert.ok(result.includes('"a"'));
  assert.ok(result.includes('"b"'));
  assert.ok(result.startsWith("["));
  assert.ok(result.endsWith("]"));
});

test("renderTsValue renders object with properties", () => {
  const result = renderTsValue({ name: "test" }, { indentLevel: 0, withinInlinePolicy: false });
  assert.ok(result.includes("name:"));
  assert.ok(result.includes('"test"'));
});

test("renderTsValue omits undefined values in objects", () => {
  const result = renderTsValue(
    { a: "yes", b: undefined },
    { indentLevel: 0, withinInlinePolicy: false },
  );
  assert.ok(result.includes("a:"));
  assert.ok(!result.includes("b:"));
});

test("renderTsValue throws on bare undefined", () => {
  assert.throws(() => {
    renderTsValue(undefined, { indentLevel: 0, withinInlinePolicy: false });
  });
});

test("renderTsValue renders IAM actions with iam helper when withinInlinePolicy", () => {
  const result = renderTsValue("s3:GetObject", {
    indentLevel: 0,
    withinInlinePolicy: true,
    parentPropertyName: "Action",
  });
  assert.equal(result, 'iam.s3("GetObject")');
});

test("renderTsValue renders unknown IAM actions as plain strings", () => {
  const result = renderTsValue("s3:FakeAction", {
    indentLevel: 0,
    withinInlinePolicy: true,
    parentPropertyName: "Action",
  });
  assert.equal(result, '"s3:FakeAction"');
});

test("renderPicklistSchema renders empty values", () => {
  const result = renderPicklistSchema({ values: [] });
  assert.equal(result, 'v.picklist(["__EMPTY_PICKLIST__"])');
});

test("renderPicklistSchema sorts values alphabetically", () => {
  const result = renderPicklistSchema({ values: ["beta", "alpha"] });
  assert.ok(result.indexOf('"alpha"') < result.indexOf('"beta"'));
});

test("sortJsonRecord sorts keys alphabetically", () => {
  const input = { z: 1, a: 2, m: 3 };
  const result = sortJsonRecord(input);
  assert.deepEqual(Object.keys(result), ["a", "m", "z"]);
  assert.deepEqual(result, { a: 2, m: 3, z: 1 });
});

test("isJsonRecord returns true for plain objects", () => {
  assert.equal(isJsonRecord({}), true);
  assert.equal(isJsonRecord({ a: 1 }), true);
});

test("isJsonRecord returns false for arrays", () => {
  assert.equal(isJsonRecord([]), false);
});

test("isJsonRecord returns false for null and primitives", () => {
  assert.equal(isJsonRecord(null), false);
  assert.equal(isJsonRecord(undefined), false);
  assert.equal(isJsonRecord("string"), false);
  assert.equal(isJsonRecord(42), false);
});
