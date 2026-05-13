import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCliError,
  CliError,
  exitCodeForCliErrorKind,
  toPreconditionError,
  toUsageError,
  toValidationError,
} from "./error.js";

test("classifyCliError returns typed kind for CliError", () => {
  const usage = classifyCliError(toUsageError("bad usage"));
  const validation = classifyCliError(toValidationError("bad input"));
  const precondition = classifyCliError(toPreconditionError("missing setup"));
  assert.equal(usage.kind, "usage");
  assert.equal(validation.kind, "validation");
  assert.equal(precondition.kind, "precondition");
});

test("classifyCliError classifies usage message fallback", () => {
  const classified = classifyCliError(
    new Error(
      "Missing required --instance-arn for bootstrap in non-interactive mode.",
    ),
  );
  assert.equal(classified.kind, "usage");
});

test("classifyCliError classifies validation message fallback", () => {
  const classified = classifyCliError(
    new Error('Invalid --instance-arn value: "x".'),
  );
  assert.equal(classified.kind, "validation");
});

test("classifyCliError classifies precondition message fallback", () => {
  const classified = classifyCliError(
    new Error('Could not find "Graveyard" OU in aws.config.ts.'),
  );
  assert.equal(classified.kind, "precondition");
});

test("classifyCliError falls back to runtime", () => {
  const classified = classifyCliError(new Error("socket hang up"));
  assert.equal(classified.kind, "runtime");
});

test("exitCodeForCliErrorKind maps deterministic codes", () => {
  assert.equal(exitCodeForCliErrorKind("usage"), 2);
  assert.equal(exitCodeForCliErrorKind("validation"), 3);
  assert.equal(exitCodeForCliErrorKind("precondition"), 4);
  assert.equal(exitCodeForCliErrorKind("runtime"), 1);
});

test("CliError preserves name and kind", () => {
  const error = new CliError("usage", "oops");
  assert.equal(error.name, "CliError");
  assert.equal(error.kind, "usage");
});
