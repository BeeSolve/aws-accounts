import assert from "node:assert/strict";
import test from "node:test";
import {
  assertIamPolicyDocument,
  isIamPolicyDocument,
  isIamPolicyStatement,
} from "./iamPolicy.js";

test("isIamPolicyDocument accepts a valid AWS IAM policy document", () => {
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadOnly",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:ListBucket"],
        Resource: "*",
        Condition: {
          StringEquals: {
            "aws:RequestedRegion": ["eu-central-1"],
          },
        },
      },
    ],
  };

  assert.equal(isIamPolicyDocument(policy), true);
  assert.equal(
    isIamPolicyStatement(policy.Statement[0]),
    true,
  );
  assert.deepEqual(assertIamPolicyDocument(policy), policy);
});

test("isIamPolicyDocument rejects invalid policy documents", () => {
  assert.equal(
    isIamPolicyDocument({
      Version: "2012-10-17",
      Statement: {
        Effect: "Permit",
        Action: "s3:GetObject",
        Resource: "*",
      },
    }),
    false,
  );
  assert.equal(
    isIamPolicyDocument({
      Version: "2012-10-17",
    }),
    false,
  );
  assert.throws(() =>
    assertIamPolicyDocument({
      Statement: {
        Effect: "Permit",
      },
    }),
  );
});
