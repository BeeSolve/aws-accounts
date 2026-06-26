import assert from "node:assert/strict";
import test, { mock } from "node:test";

import fc from "fast-check";

import type { Operation } from "../operations.js";
import type { StateFile } from "../state.js";

// --- Mock S3ServiceException class ---
// This must be defined before mock.module so the handler's instanceof check works.

class MockS3ServiceException extends Error {
  $metadata: { httpStatusCode?: number };
  $fault: string;
  constructor(opts: {
    name: string;
    message: string;
    $fault: string;
    $metadata: { httpStatusCode?: number };
  }) {
    super(opts.message);
    this.name = opts.name;
    this.$fault = opts.$fault;
    this.$metadata = opts.$metadata;
  }
}

// --- Minimal valid state for mocked S3 GetObject ---

const minimalState: StateFile = {
  version: "1",
  generatedAt: "2026-01-01T00:00:00.000Z",
  organization: {
    organizationId: "o-test123",
    rootId: "r-root",
    organizationalUnits: [],
    accounts: [],
  },
  identityCenter: {
    instanceArn: "arn:aws:sso:::instance/ssoins-1",
    identityStoreId: "d-1",
    users: [],
    groups: [],
    groupMemberships: [],
    permissionSets: [],
    accountAssignments: [],
    accessRoles: [],
    accessControlAttributes: [],
  },
};

// --- Set up module mocks BEFORE handler is imported ---

// Mock S3Client.send:
// - GetObjectCommand → return valid state with ETag
// - PutObjectCommand → throw PreconditionFailed (S3ServiceException)
const mockS3Send = mock.fn(async (command: unknown) => {
  const commandName = (command as { constructor: { name: string } }).constructor.name;
  if (commandName === "GetObjectCommand") {
    return {
      Body: {
        transformToString: async () => JSON.stringify(minimalState),
      },
      ETag: '"mock-etag-456"',
    };
  }
  if (commandName === "PutObjectCommand") {
    const error = new MockS3ServiceException({
      name: "PreconditionFailed",
      message: "At least one of the pre-conditions you specified did not hold",
      $fault: "client",
      $metadata: { httpStatusCode: 412 },
    });
    throw error;
  }
  return {};
});

mock.module("@aws-sdk/client-s3", {
  namedExports: {
    S3Client: class {
      send = mockS3Send;
    },
    GetObjectCommand: class GetObjectCommand {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
    PutObjectCommand: class PutObjectCommand {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
    CreateBucketCommand: class CreateBucketCommand {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
    PutBucketPolicyCommand: class PutBucketPolicyCommand {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
    PutPublicAccessBlockCommand: class PutPublicAccessBlockCommand {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
    PutBucketTaggingCommand: class PutBucketTaggingCommand {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
    S3ServiceException: MockS3ServiceException,
  },
});

mock.module("@aws-sdk/s3-request-presigner", {
  namedExports: {
    getSignedUrl: async () => "https://mock-presigned-url.example.com",
  },
});

mock.module("@aws-sdk/client-sts", {
  namedExports: {
    STSClient: class {
      send = async () => ({});
    },
    AssumeRoleCommand: class {
      constructor() {}
    },
  },
});

mock.module("@aws-sdk/client-organizations", {
  namedExports: {
    OrganizationsClient: class {
      send = async () => ({});
    },
    DescribeOrganizationCommand: class {
      constructor() {}
    },
  },
});

mock.module("@aws-sdk/client-sso-admin", {
  namedExports: {
    SSOAdminClient: class {
      send = async () => ({});
    },
  },
});

mock.module("@aws-sdk/client-identitystore", {
  namedExports: {
    IdentitystoreClient: class {
      send = async () => ({});
    },
  },
});

mock.module("@aws-sdk/client-account", {
  namedExports: {
    AccountClient: class {
      send = async () => ({});
    },
  },
});

// Mock executeOperation to always succeed (return working state unchanged)
const mockExecuteOperation = mock.fn(async (props: { state: unknown }) => props.state);

mock.module("../applyLogic.js", {
  namedExports: {
    executeOperation: mockExecuteOperation,
  },
});

mock.module("../scanLogic.js", {
  namedExports: {
    scanOrganization: async () => minimalState.organization,
    scanIdentityCenter: async () => minimalState.identityCenter,
  },
});

// Set required environment variable
process.env.STATE_BUCKET_NAME = "test-bucket";

// --- Import handler AFTER mocks are set up ---
const { handler } = await import("./handler.js");

// --- Generators ---

/** Generate a non-empty string */
const nonEmptyStringArb = fc
  .string({ minLength: 1, maxLength: 50 })
  .filter((s) => s.trim().length > 0);

/** Generate a valid moveAccount operation (simplest operation kind) */
const moveAccountOperationArb: fc.Arbitrary<Operation> = fc.record({
  kind: fc.constant("moveAccount" as const),
  accountId: nonEmptyStringArb,
  accountName: nonEmptyStringArb,
  fromOuId: nonEmptyStringArb,
  fromOuName: nonEmptyStringArb,
  toOuId: nonEmptyStringArb,
  toOuName: nonEmptyStringArb,
});

/** Generate a non-empty array of operations (1 to 5) */
const operationsArb = fc.array(moveAccountOperationArb, {
  minLength: 1,
  maxLength: 5,
});

// --- Property Test ---

/**
 * Feature: remote-execution-v2, Property 6: Concurrency conflict detection
 *
 * For any set of operations that all succeed, if the final S3 write fails
 * with PreconditionFailed, the response is always a concurrencyConflict error.
 *
 * **Validates: Requirements 8.1, 8.3**
 */
test("Property 6: Concurrency conflict detection — S3 PreconditionFailed maps to concurrencyConflict error kind", async () => {
  await fc.assert(
    fc.asyncProperty(operationsArb, async (operations) => {
      // Reset mock call counts between iterations
      mockS3Send.mock.resetCalls();
      mockExecuteOperation.mock.resetCalls();

      const event = {
        action: "apply" as const,
        operations,
        allowDestructive: false,
      };

      const response = await handler(event);

      // Verify the response indicates a concurrency conflict
      assert.equal(
        response.success,
        false,
        `Expected success=false for ${operations.length} operations`,
      );
      assert.ok("error" in response, "Response should have an error field");
      if ("error" in response) {
        const errorResponse = response as {
          success: false;
          error: { kind: string; message: string };
        };
        assert.equal(
          errorResponse.error.kind,
          "concurrencyConflict",
          `Expected error.kind="concurrencyConflict", got "${errorResponse.error.kind}"`,
        );
        assert.ok(errorResponse.error.message.length > 0, "Error message should be non-empty");
      }
    }),
    { numRuns: 100 },
  );
});
