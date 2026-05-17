import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import type { StateFile } from "../state.js";
import type { Operation } from "../operations.js";

// --- Minimal valid state for mocked S3 GetObject ---

const minimalState: StateFile = {
  version: "1",
  generatedAt: "2026-01-01T00:00:00.000Z",
  organization: {
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
// - PutObjectCommand → succeed (no conflict)
const mockS3Send = mock.fn(async (command: unknown) => {
  const commandName = (command as { constructor: { name: string } }).constructor
    .name;
  if (commandName === "GetObjectCommand") {
    return {
      Body: {
        transformToString: async () => JSON.stringify(minimalState),
      },
      ETag: '"mock-etag-789"',
    };
  }
  if (commandName === "PutObjectCommand") {
    // S3 write succeeds
    return {};
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
    S3ServiceException: class S3ServiceException extends Error {
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
    },
  },
});

mock.module("@aws-sdk/s3-request-presigner", {
  namedExports: {
    getSignedUrl: async () => "https://mock-presigned-url.example.com",
  },
});

mock.module("@aws-sdk/client-organizations", {
  namedExports: {
    OrganizationsClient: class {
      send = async () => ({});
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

// Track call count and fail at a specific index
let executeCallCount = 0;
let failAtIndex = 0;

const mockExecuteOperation = mock.fn(
  async (props: { state: unknown }) => {
    const currentIndex = executeCallCount;
    executeCallCount++;
    if (currentIndex === failAtIndex) {
      throw new Error(`Operation ${currentIndex} failed intentionally`);
    }
    // Return the working state unchanged for successful operations
    return props.state;
  },
);

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

// --- Property Test ---

/**
 * Feature: remote-execution-v2, Property 5: Apply partial failure reports correct completed count
 *
 * For any list of N operations where operation at index K (0-based) fails,
 * the Lambda handler returns an error response with `operationsCompleted` equal to K
 * and a non-empty error message describing the failure.
 *
 * **Validates: Requirements 6.8**
 */
test("Property 5: Apply partial failure reports correct completed count — when operation K fails, operationsCompleted equals K", async () => {
  // Generate N (1-10) and K (0 to N-1)
  const nkArb = fc
    .integer({ min: 1, max: 10 })
    .chain((n) =>
      fc.tuple(fc.constant(n), fc.integer({ min: 0, max: n - 1 })),
    );

  await fc.assert(
    fc.asyncProperty(nkArb, async ([n, k]) => {
      // Reset mock state for this iteration
      executeCallCount = 0;
      failAtIndex = k;
      mockS3Send.mock.resetCalls();
      mockExecuteOperation.mock.resetCalls();

      // Reset the implementation to use current failAtIndex
      mockExecuteOperation.mock.mockImplementation(
        async (props: { state: unknown }) => {
          const currentIndex = executeCallCount;
          executeCallCount++;
          if (currentIndex === failAtIndex) {
            throw new Error(
              `Operation ${currentIndex} failed intentionally`,
            );
          }
          return props.state;
        },
      );
      // Reset call count after mockImplementation
      executeCallCount = 0;

      // Generate N operations
      const operations: Operation[] = Array.from({ length: n }, (_, i) => ({
        kind: "moveAccount" as const,
        accountId: `acct-${i}`,
        accountName: `Account ${i}`,
        fromOuId: `ou-from-${i}`,
        fromOuName: `FromOU ${i}`,
        toOuId: `ou-to-${i}`,
        toOuName: `ToOU ${i}`,
      }));

      const event = {
        action: "apply" as const,
        operations,
        allowDestructive: true,
      };

      const response = await handler(event);

      // Verify the response indicates failure
      assert.equal(
        response.success,
        false,
        `Expected success=false for N=${n}, K=${k}`,
      );
      assert.ok(
        "error" in response,
        `Expected error field in response for N=${n}, K=${k}`,
      );

      if ("error" in response) {
        const errorResponse = response as {
          success: false;
          error: {
            kind: string;
            message: string;
            details?: {
              operationsCompleted?: number;
              failedOperation?: number;
            };
          };
        };

        assert.equal(
          errorResponse.error.kind,
          "operationFailed",
          `Expected error.kind="operationFailed" for N=${n}, K=${k}, got "${errorResponse.error.kind}"`,
        );

        assert.ok(
          errorResponse.error.message.length > 0,
          `Expected non-empty error message for N=${n}, K=${k}`,
        );

        assert.ok(
          errorResponse.error.details != null,
          `Expected error.details for N=${n}, K=${k}`,
        );

        assert.equal(
          errorResponse.error.details?.operationsCompleted,
          k,
          `Expected operationsCompleted=${k} for N=${n}, K=${k}, got ${errorResponse.error.details?.operationsCompleted}`,
        );

        assert.equal(
          errorResponse.error.details?.failedOperation,
          k,
          `Expected failedOperation=${k} for N=${n}, K=${k}, got ${errorResponse.error.details?.failedOperation}`,
        );
      }
    }),
    { numRuns: 100 },
  );
});
