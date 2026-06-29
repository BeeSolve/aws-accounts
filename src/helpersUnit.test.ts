import assert from "node:assert/strict";
import test from "node:test";

import { getErrorCode, getErrorName, sortJsonValue } from "./helpers.js";

test("getErrorName returns name from Error instances", () => {
  const error = new Error("test");
  error.name = "CustomError";
  assert.equal(getErrorName(error), "CustomError");
});

test("getErrorName returns name from plain objects with name property", () => {
  assert.equal(getErrorName({ name: "NotFoundError", message: "not found" }), "NotFoundError");
});

test("getErrorName returns undefined for null", () => {
  assert.equal(getErrorName(null), undefined);
});

test("getErrorName returns undefined for primitives", () => {
  assert.equal(getErrorName("string error"), undefined);
  assert.equal(getErrorName(42), undefined);
  assert.equal(getErrorName(undefined), undefined);
});

test("getErrorName returns undefined for objects without name", () => {
  assert.equal(getErrorName({ message: "no name" }), undefined);
});

test("getErrorCode returns code from objects with code property", () => {
  assert.equal(getErrorCode({ code: "ENOENT" }), "ENOENT");
});

test("getErrorCode returns undefined for null", () => {
  assert.equal(getErrorCode(null), undefined);
});

test("getErrorCode returns undefined for objects without code", () => {
  assert.equal(getErrorCode({ name: "Error" }), undefined);
});

test("getErrorCode returns undefined for primitives", () => {
  assert.equal(getErrorCode("string"), undefined);
});

test("sortJsonValue sorts object keys alphabetically", () => {
  const input = { z: 1, a: 2, m: 3 };
  const result = sortJsonValue(input) as Record<string, number>;
  assert.deepEqual(Object.keys(result), ["a", "m", "z"]);
});

test("sortJsonValue recurses into nested objects", () => {
  const input = { b: { z: 1, a: 2 }, a: 1 };
  const result = sortJsonValue(input) as Record<string, unknown>;
  assert.deepEqual(Object.keys(result), ["a", "b"]);
  assert.deepEqual(Object.keys(result.b as Record<string, unknown>), ["a", "z"]);
});

test("sortJsonValue recurses into arrays", () => {
  const input = [{ b: 1, a: 2 }];
  const result = sortJsonValue(input) as Array<Record<string, number>>;
  assert.deepEqual(Object.keys(result[0]), ["a", "b"]);
});

test("sortJsonValue returns primitives unchanged", () => {
  assert.equal(sortJsonValue("hello"), "hello");
  assert.equal(sortJsonValue(42), 42);
  assert.equal(sortJsonValue(null), null);
  assert.equal(sortJsonValue(true), true);
});
