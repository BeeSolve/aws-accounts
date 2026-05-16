import test from "node:test";
import assert from "node:assert/strict";
import { TooManyRequestsException } from "@aws-sdk/client-lambda";
import type { LambdaClient } from "@aws-sdk/client-lambda";
import { invokeLambda, type LambdaRequestPayload } from "./lambdaClient.js";

// --- Helpers ---

function createScanPayload(): LambdaRequestPayload {
  return { action: "scan" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockLambdaClient(sendFn: (command: unknown) => Promise<any>): LambdaClient {
  return { send: sendFn } as unknown as LambdaClient;
}

function encodePayload(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function createValidScanResponse() {
  return {
    action: "scan" as const,
    success: true as const,
    summary: {
      organizationalUnits: 2,
      accounts: 3,
      users: 1,
      groups: 1,
      permissionSets: 1,
      accountAssignments: 2,
    },
    state: {
      version: "1",
      generatedAt: "2026-05-06T00:00:00.000Z",
      organization: {
        rootId: "r-root",
        organizationalUnits: [
          { id: "ou-a", parentId: "r-root", arn: "arn:ou:a", name: "Alpha" },
          { id: "ou-b", parentId: "r-root", arn: "arn:ou:b", name: "Beta" },
        ],
        accounts: [
          { id: "111111111111", arn: "arn:acct:1", name: "Acct1", email: "a@x.com", status: "ACTIVE", parentId: "ou-a", tags: [] },
          { id: "222222222222", arn: "arn:acct:2", name: "Acct2", email: "b@x.com", status: "ACTIVE", parentId: "ou-a", tags: [] },
          { id: "333333333333", arn: "arn:acct:3", name: "Acct3", email: "c@x.com", status: "ACTIVE", parentId: "ou-b", tags: [] },
        ],
      },
      identityCenter: {
        instanceArn: "arn:aws:sso:::instance/ssoins-123",
        identityStoreId: "d-123",
        users: [{ userId: "u-1", userName: "alice", displayName: "Alice", email: "alice@x.com" }],
        groups: [{ groupId: "g-1", displayName: "Admins" }],
        groupMemberships: [],
        permissionSets: [{ permissionSetArn: "arn:ps:1", name: "Admin", description: "Full access", sessionDuration: null, inlinePolicy: null, awsManagedPolicies: ["arn:aws:iam::aws:policy/AdministratorAccess"], customerManagedPolicies: [] }],
        accountAssignments: [
          { accountId: "111111111111", permissionSetArn: "arn:ps:1", principalId: "g-1", principalType: "GROUP" },
          { accountId: "222222222222", permissionSetArn: "arn:ps:1", principalId: "g-1", principalType: "GROUP" },
        ],
        accessRoles: [],
      },
    },
  };
}

// --- Tests ---

test("invokeLambda returns ok:true with parsed response for successful scan", async () => {
  const scanResponse = createValidScanResponse();
  const client = createMockLambdaClient(async () => ({
    StatusCode: 200,
    Payload: encodePayload(scanResponse),
    $metadata: {},
  }));

  const result = await invokeLambda({
    lambdaClient: client,
    lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
    payload: createScanPayload(),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.response, scanResponse);
  }
});

test("invokeLambda maps Lambda error response with kind:validation to validation error", async () => {
  const errorResponse = {
    success: false,
    error: {
      kind: "validation",
      message: "Invalid operation payload",
      details: {
        validationIssues: ["operations: expected array, got string"],
      },
    },
  };
  const client = createMockLambdaClient(async () => ({
    StatusCode: 200,
    Payload: encodePayload(errorResponse),
    $metadata: {},
  }));

  const result = await invokeLambda({
    lambdaClient: client,
    lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
    payload: createScanPayload(),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "validation");
    if (result.error.kind === "validation") {
      assert.equal(result.error.details, "Invalid operation payload");
    }
  }
});

test("invokeLambda maps TooManyRequestsException to concurrencyConflict error", async () => {
  const client = createMockLambdaClient(async () => {
    throw new TooManyRequestsException({
      message: "Rate exceeded",
      $metadata: {},
    });
  });

  const result = await invokeLambda({
    lambdaClient: client,
    lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
    payload: createScanPayload(),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "concurrencyConflict");
    if (result.error.kind === "concurrencyConflict") {
      assert.ok(result.error.message.length > 0);
    }
  }
});

test("invokeLambda maps FunctionError to invocationError", async () => {
  const errorPayload = JSON.stringify({ errorMessage: "Task timed out after 30.00 seconds" });
  const client = createMockLambdaClient(async () => ({
    StatusCode: 200,
    FunctionError: "Unhandled",
    Payload: new TextEncoder().encode(errorPayload),
    $metadata: {},
  }));

  const result = await invokeLambda({
    lambdaClient: client,
    lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
    payload: createScanPayload(),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "invocationError");
    if (result.error.kind === "invocationError") {
      assert.ok(result.error.message.includes("Task timed out"));
    }
  }
});

test("invokeLambda maps generic network error to invocationError", async () => {
  const client = createMockLambdaClient(async () => {
    throw new Error("Network connection refused");
  });

  const result = await invokeLambda({
    lambdaClient: client,
    lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
    payload: createScanPayload(),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "invocationError");
    if (result.error.kind === "invocationError") {
      assert.equal(result.error.message, "Network connection refused");
    }
  }
});

test("invokeLambda maps non-JSON response payload to invocationError", async () => {
  const client = createMockLambdaClient(async () => ({
    StatusCode: 200,
    Payload: new TextEncoder().encode("this is not json {{{"),
    $metadata: {},
  }));

  const result = await invokeLambda({
    lambdaClient: client,
    lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
    payload: createScanPayload(),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "invocationError");
    if (result.error.kind === "invocationError") {
      assert.ok(result.error.message.includes("Failed to parse"));
    }
  }
});

test("invokeLambda maps valid JSON that fails schema validation to validation error", async () => {
  // Valid JSON but doesn't match any response schema variant
  const invalidResponse = {
    action: "scan",
    success: true,
    // missing required fields: summary, state
  };
  const client = createMockLambdaClient(async () => ({
    StatusCode: 200,
    Payload: encodePayload(invalidResponse),
    $metadata: {},
  }));

  const result = await invokeLambda({
    lambdaClient: client,
    lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
    payload: createScanPayload(),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "validation");
    if (result.error.kind === "validation") {
      assert.ok(result.error.details.includes("Lambda response validation failed"));
    }
  }
});
