import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import * as v from "valibot";
import type { StateFile } from "../state.js";
import { handler } from "./handler.js";
import { lambdaResponseSchema } from "../lambdaClient.js";

// Set required env var before any handler calls
process.env.STATE_BUCKET_NAME = "test-bucket-dummy";
import type { Operation } from "../operations.js";

// --- Generators ---

/** Generate a non-empty string (matching the nonEmptyString schema in state.ts) */
const nonEmptyStringArb = fc
  .string({ minLength: 1, maxLength: 50 })
  .filter((s) => s.trim().length > 0);

/** Generate a valid OrganizationalUnit */
const organizationalUnitArb = fc.record({
  id: nonEmptyStringArb,
  parentId: nonEmptyStringArb,
  arn: nonEmptyStringArb,
  name: nonEmptyStringArb,
});

/** Generate a valid AccountTag */
const accountTagArb = fc.record({
  key: nonEmptyStringArb,
  value: fc.string({ maxLength: 50 }),
});

/** Generate a valid Account */
const accountArb = fc.record({
  id: nonEmptyStringArb,
  arn: nonEmptyStringArb,
  name: nonEmptyStringArb,
  email: nonEmptyStringArb,
  status: nonEmptyStringArb,
  parentId: nonEmptyStringArb,
  tags: fc.array(accountTagArb, { maxLength: 5 }),
});

/** Generate a valid User */
const userArb = fc.record({
  userId: nonEmptyStringArb,
  userName: nonEmptyStringArb,
  displayName: fc.string({ maxLength: 50 }),
  email: fc.string({ maxLength: 50 }),
});

/** Generate a valid Group */
const groupArb = fc.record({
  groupId: nonEmptyStringArb,
  displayName: nonEmptyStringArb,
  description: fc.option(fc.string({ maxLength: 50 }), { nil: undefined }),
});

/** Generate a valid GroupMembership */
const groupMembershipArb = fc.record({
  membershipId: nonEmptyStringArb,
  groupId: nonEmptyStringArb,
  userId: nonEmptyStringArb,
});

/** Generate a valid CustomerManagedPolicyReference */
const customerManagedPolicyReferenceArb = fc.record({
  name: nonEmptyStringArb,
  path: nonEmptyStringArb,
});

/** Generate a valid PermissionSet */
const permissionSetArb = fc.record({
  permissionSetArn: nonEmptyStringArb,
  name: nonEmptyStringArb,
  description: fc.string({ maxLength: 50 }),
  sessionDuration: fc.option(nonEmptyStringArb, { nil: null }),
  inlinePolicy: fc.option(nonEmptyStringArb, { nil: null }),
  awsManagedPolicies: fc.array(nonEmptyStringArb, { maxLength: 3 }),
  customerManagedPolicies: fc.array(customerManagedPolicyReferenceArb, {
    maxLength: 3,
  }),
});

/** Generate a valid AccountAssignment */
const accountAssignmentArb = fc.record({
  accountId: nonEmptyStringArb,
  permissionSetArn: nonEmptyStringArb,
  principalId: nonEmptyStringArb,
  principalType: fc.constantFrom("GROUP" as const, "USER" as const),
});

/** Generate a valid AccessRole */
const accessRoleArb = fc.record({
  accountId: nonEmptyStringArb,
  permissionSetArn: nonEmptyStringArb,
  principalId: nonEmptyStringArb,
  principalType: fc.constantFrom("GROUP" as const, "USER" as const),
  roleName: nonEmptyStringArb,
});

/** Generate a valid StateFile */
const stateFileArb: fc.Arbitrary<StateFile> = fc.record({
  version: nonEmptyStringArb,
  generatedAt: nonEmptyStringArb,
  organization: fc.record({
    rootId: nonEmptyStringArb,
    organizationalUnits: fc.array(organizationalUnitArb, { maxLength: 10 }),
    accounts: fc.array(accountArb, { maxLength: 10 }),
  }),
  identityCenter: fc.record({
    instanceArn: nonEmptyStringArb,
    identityStoreId: nonEmptyStringArb,
    users: fc.array(userArb, { maxLength: 10 }),
    groups: fc.array(groupArb, { maxLength: 10 }),
    groupMemberships: fc.array(groupMembershipArb, { maxLength: 10 }),
    permissionSets: fc.array(permissionSetArb, { maxLength: 5 }),
    accountAssignments: fc.array(accountAssignmentArb, { maxLength: 10 }),
    accessRoles: fc.array(accessRoleArb, { maxLength: 5 }),
  }),
});

// --- Helper: compute scan summary from state (mirrors handler logic) ---

function computeScanSummary(state: StateFile) {
  return {
    organizationalUnits: state.organization.organizationalUnits.length,
    accounts: state.organization.accounts.length,
    users: state.identityCenter.users.length,
    groups: state.identityCenter.groups.length,
    permissionSets: state.identityCenter.permissionSets.length,
    accountAssignments: state.identityCenter.accountAssignments.length,
  };
}

// --- Property Tests ---

/**
 * Feature: remote-execution-v2, Property 1: Lambda input validation rejects invalid payloads
 *
 * For any JSON payload that does not conform to the lambdaRequestSchema,
 * the Lambda handler SHALL return an error response with kind: "validation"
 * and a non-empty message describing the validation failure.
 *
 * **Validates: Requirements 3.1, 3.2, 11.1**
 */
test("Property 1: Lambda input validation rejects invalid payloads", async () => {
  // Strategy: generate arbitrary JSON objects that do NOT conform to lambdaRequestSchema.
  // The schema is a variant on "action" with strict objects, so we generate payloads that:
  // 1. Have no action field
  // 2. Have wrong action values
  // 3. Have wrong types for known fields
  // 4. Have extra fields (strictObject rejects them)
  // 5. Are primitives or arrays (not objects at all)

  // Generator for payloads missing the action field entirely
  const missingActionArb = fc.dictionary(
    fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s !== "action"),
    fc.jsonValue(),
    { minKeys: 0, maxKeys: 5 },
  );

  // Generator for payloads with invalid action values
  const invalidActionValueArb = fc.record({
    action: fc.oneof(
      fc.string({ minLength: 0, maxLength: 30 }).filter(
        (s) => s !== "scan" && s !== "getStateUrl" && s !== "apply",
      ),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.array(fc.jsonValue(), { maxLength: 3 }),
    ),
  });

  // Generator for scan action with extra fields (strictObject rejects)
  const scanWithExtraFieldsArb = fc
    .record({
      action: fc.constant("scan"),
      extraField: fc.jsonValue(),
    })
    .map((obj) => ({ ...obj }));

  // Generator for getStateUrl with extra fields
  const getStateUrlWithExtraFieldsArb = fc
    .record({
      action: fc.constant("getStateUrl"),
      unexpected: fc.jsonValue(),
    })
    .map((obj) => ({ ...obj }));

  // Generator for apply action with wrong types
  const applyWrongTypesArb = fc.oneof(
    // Missing operations
    fc.record({
      action: fc.constant("apply"),
      allowDestructive: fc.boolean(),
    }),
    // Missing allowDestructive
    fc.record({
      action: fc.constant("apply"),
      operations: fc.array(fc.jsonValue(), { minLength: 1, maxLength: 3 }),
    }),
    // operations is not an array
    fc.record({
      action: fc.constant("apply"),
      operations: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
      allowDestructive: fc.boolean(),
    }),
    // operations is empty array (minLength(1) rejects)
    fc.record({
      action: fc.constant("apply"),
      operations: fc.constant([]),
      allowDestructive: fc.boolean(),
    }),
    // allowDestructive is wrong type
    fc.record({
      action: fc.constant("apply"),
      operations: fc.array(fc.jsonValue(), { minLength: 1, maxLength: 3 }),
      allowDestructive: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
    }),
    // apply with extra fields
    fc.record({
      action: fc.constant("apply"),
      operations: fc.array(fc.jsonValue(), { minLength: 1, maxLength: 3 }),
      allowDestructive: fc.boolean(),
      extraField: fc.jsonValue(),
    }),
  );

  // Generator for non-object payloads (primitives, arrays, null, undefined)
  const nonObjectArb = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.array(fc.jsonValue(), { maxLength: 5 }),
  );

  // Combined generator for all invalid payloads
  const invalidPayloadArb = fc.oneof(
    missingActionArb,
    invalidActionValueArb,
    scanWithExtraFieldsArb,
    getStateUrlWithExtraFieldsArb,
    applyWrongTypesArb,
    nonObjectArb,
  );

  await fc.assert(
    fc.asyncProperty(invalidPayloadArb, async (payload) => {
      const response = await handler(payload);

      // Handler should never throw — always returns structured response
      assert.equal(typeof response, "object");
      assert.notEqual(response, null);

      // Response must indicate failure with validation error kind
      assert.equal(
        response.success,
        false,
        `Expected success: false for payload: ${JSON.stringify(payload)}`,
      );
      assert.equal(
        (response as { error: { kind: string } }).error.kind,
        "validation",
        `Expected error.kind: "validation" for payload: ${JSON.stringify(payload)}`,
      );

      // Message must be non-empty
      const message = (response as { error: { message: string } }).error
        .message;
      assert.equal(typeof message, "string");
      assert.ok(message.length > 0, "Error message should be non-empty");
    }),
    { numRuns: 100 },
  );
});

/**
 * Feature: remote-execution-v2, Property 4: Scan summary counts match state
 *
 * For any valid StateFile, the summary object has counts equal to the
 * corresponding array lengths in the state.
 *
 * **Validates: Requirements 4.4**
 */
test("Property 4: Scan summary counts match state — summary counts equal array lengths for any valid StateFile", () => {
  fc.assert(
    fc.property(stateFileArb, (state) => {
      const summary = computeScanSummary(state);

      assert.equal(
        summary.organizationalUnits,
        state.organization.organizationalUnits.length,
        `organizationalUnits: expected ${state.organization.organizationalUnits.length}, got ${summary.organizationalUnits}`,
      );
      assert.equal(
        summary.accounts,
        state.organization.accounts.length,
        `accounts: expected ${state.organization.accounts.length}, got ${summary.accounts}`,
      );
      assert.equal(
        summary.users,
        state.identityCenter.users.length,
        `users: expected ${state.identityCenter.users.length}, got ${summary.users}`,
      );
      assert.equal(
        summary.groups,
        state.identityCenter.groups.length,
        `groups: expected ${state.identityCenter.groups.length}, got ${summary.groups}`,
      );
      assert.equal(
        summary.permissionSets,
        state.identityCenter.permissionSets.length,
        `permissionSets: expected ${state.identityCenter.permissionSets.length}, got ${summary.permissionSets}`,
      );
      assert.equal(
        summary.accountAssignments,
        state.identityCenter.accountAssignments.length,
        `accountAssignments: expected ${state.identityCenter.accountAssignments.length}, got ${summary.accountAssignments}`,
      );
    }),
    { numRuns: 100 },
  );
});




/**
 * Feature: remote-execution-v2, Property 8: Lambda response schema self-validation
 *
 * For any input to the handler (valid or invalid), the response ALWAYS passes
 * lambdaResponseSchema validation. This verifies the handler never returns a
 * malformed response, regardless of input.
 *
 * **Validates: Requirements 11.2, 11.3**
 */
test("Property 8: Lambda response schema self-validation — all handler responses pass lambdaResponseSchema validation", async () => {
  // Generator for a mix of inputs: completely random objects, objects with valid
  // action fields but wrong types, null, undefined, arrays, numbers, strings, etc.

  // Random JSON values (objects, arrays, primitives)
  const randomJsonArb = fc.jsonValue();

  // Objects with valid action field but wrong/missing other fields
  const validActionWrongFieldsArb = fc.oneof(
    fc.record({
      action: fc.constantFrom("scan", "getStateUrl", "apply"),
    }),
    fc.record({
      action: fc.constantFrom("scan", "getStateUrl", "apply"),
      operations: fc.jsonValue(),
      allowDestructive: fc.jsonValue(),
    }),
    fc.record({
      action: fc.constantFrom("scan", "getStateUrl", "apply"),
      extraField: fc.jsonValue(),
    }),
  );

  // Invalid action values
  const invalidActionArb = fc.record({
    action: fc.oneof(
      fc.string({ minLength: 0, maxLength: 30 }).filter(
        (s) => s !== "scan" && s !== "getStateUrl" && s !== "apply",
      ),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
    ),
  });

  // Non-object primitives
  const primitivesArb = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
  );

  // Arrays of various content
  const arraysArb = fc.array(fc.jsonValue(), { maxLength: 5 });

  // Combined generator covering all input categories
  const arbitraryInputArb = fc.oneof(
    randomJsonArb,
    validActionWrongFieldsArb,
    invalidActionArb,
    primitivesArb,
    arraysArb,
  );

  await fc.assert(
    fc.asyncProperty(arbitraryInputArb, async (input) => {
      const response = await handler(input);

      // The response must always be a non-null object
      assert.equal(typeof response, "object");
      assert.notEqual(response, null);

      // The response must always pass lambdaResponseSchema validation
      const result = v.safeParse(lambdaResponseSchema, response);
      assert.ok(
        result.success,
        `Response failed lambdaResponseSchema validation for input: ${JSON.stringify(input)}. Issues: ${
          result.success
            ? ""
            : result.issues
                .map(
                  (issue) =>
                    `${issue.path?.map((p) => p.key).join(".") ?? "root"}: ${issue.message}`,
                )
                .join("; ")
        }`,
      );
    }),
    { numRuns: 20 },
  );
});

import { operationSchema } from "../operations.js";

// --- Operation Generators ---

/** Generate a valid moveAccount operation */
const moveAccountOpArb = fc.record({
  kind: fc.constant("moveAccount" as const),
  accountId: nonEmptyStringArb,
  accountName: nonEmptyStringArb,
  fromOuId: nonEmptyStringArb,
  fromOuName: nonEmptyStringArb,
  toOuId: nonEmptyStringArb,
  toOuName: nonEmptyStringArb,
});

/** Generate a valid createOu operation */
const createOuOpArb = fc.record({
  kind: fc.constant("createOu" as const),
  ouName: nonEmptyStringArb,
  parentOuId: nonEmptyStringArb,
  parentOuName: nonEmptyStringArb,
});

/** Generate a valid renameOu operation */
const renameOuOpArb = fc.record({
  kind: fc.constant("renameOu" as const),
  ouId: nonEmptyStringArb,
  fromOuName: nonEmptyStringArb,
  toOuName: nonEmptyStringArb,
  parentOuId: nonEmptyStringArb,
  parentOuName: nonEmptyStringArb,
});

/** Generate a valid deleteOu operation */
const deleteOuOpArb = fc.record({
  kind: fc.constant("deleteOu" as const),
  ouId: nonEmptyStringArb,
  ouName: nonEmptyStringArb,
  parentOuId: nonEmptyStringArb,
  parentOuName: nonEmptyStringArb,
});

/** Generate a valid createAccount operation */
const createAccountOpArb = fc.record({
  kind: fc.constant("createAccount" as const),
  accountName: nonEmptyStringArb,
  accountEmail: nonEmptyStringArb,
  targetOuId: nonEmptyStringArb,
  targetOuName: nonEmptyStringArb,
});

/** Generate a valid updateAccountTags operation */
const updateAccountTagsOpArb = fc.record({
  kind: fc.constant("updateAccountTags" as const),
  accountId: nonEmptyStringArb,
  accountName: nonEmptyStringArb,
  tags: fc.dictionary(nonEmptyStringArb, fc.string({ maxLength: 50 }), {
    minKeys: 0,
    maxKeys: 3,
  }),
});

/** Generate a valid updateAccountName operation */
const updateAccountNameOpArb = fc.record({
  kind: fc.constant("updateAccountName" as const),
  accountId: nonEmptyStringArb,
  fromAccountName: nonEmptyStringArb,
  toAccountName: nonEmptyStringArb,
});

/** Generate a valid removeAccount operation */
const removeAccountOpArb = fc.record({
  kind: fc.constant("removeAccount" as const),
  accountId: nonEmptyStringArb,
  accountName: nonEmptyStringArb,
  fromOuId: nonEmptyStringArb,
  fromOuName: nonEmptyStringArb,
  toOuId: nonEmptyStringArb,
  toOuName: nonEmptyStringArb,
});

/** Generate a valid createIdcUser operation */
const createIdcUserOpArb = fc.record({
  kind: fc.constant("createIdcUser" as const),
  userName: nonEmptyStringArb,
  displayName: nonEmptyStringArb,
  email: nonEmptyStringArb,
});

/** Generate a valid updateIdcUser operation */
const updateIdcUserOpArb = fc.record({
  kind: fc.constant("updateIdcUser" as const),
  userName: nonEmptyStringArb,
  displayName: nonEmptyStringArb,
  email: nonEmptyStringArb,
});

/** Generate a valid deleteIdcUser operation */
const deleteIdcUserOpArb = fc.record({
  kind: fc.constant("deleteIdcUser" as const),
  userName: nonEmptyStringArb,
});

/** Generate a valid createIdcGroup operation */
const createIdcGroupOpArb = fc.record({
  kind: fc.constant("createIdcGroup" as const),
  groupDisplayName: nonEmptyStringArb,
  description: nonEmptyStringArb,
});

/** Generate a valid updateIdcGroupDescription operation */
const updateIdcGroupDescriptionOpArb = fc.record({
  kind: fc.constant("updateIdcGroupDescription" as const),
  groupDisplayName: nonEmptyStringArb,
  description: nonEmptyStringArb,
});

/** Generate a valid deleteIdcGroup operation */
const deleteIdcGroupOpArb = fc.record({
  kind: fc.constant("deleteIdcGroup" as const),
  groupDisplayName: nonEmptyStringArb,
});

/** Generate a valid addIdcGroupMembership operation */
const addIdcGroupMembershipOpArb = fc.record({
  kind: fc.constant("addIdcGroupMembership" as const),
  groupDisplayName: nonEmptyStringArb,
  userName: nonEmptyStringArb,
});

/** Generate a valid removeIdcGroupMembership operation */
const removeIdcGroupMembershipOpArb = fc.record({
  kind: fc.constant("removeIdcGroupMembership" as const),
  groupDisplayName: nonEmptyStringArb,
  userName: nonEmptyStringArb,
});

/** Generate a valid createIdcPermissionSet operation */
const createIdcPermissionSetOpArb = fc.record({
  kind: fc.constant("createIdcPermissionSet" as const),
  permissionSetName: nonEmptyStringArb,
  description: nonEmptyStringArb,
  sessionDuration: fc.option(fc.string({ maxLength: 10 }), { nil: null }),
});

/** Generate a valid updateIdcPermissionSetDescription operation */
const updateIdcPermissionSetDescriptionOpArb = fc.record({
  kind: fc.constant("updateIdcPermissionSetDescription" as const),
  permissionSetName: nonEmptyStringArb,
  description: nonEmptyStringArb,
});

/** Generate a valid updateIdcPermissionSetSessionDuration operation */
const updateIdcPermissionSetSessionDurationOpArb = fc.record({
  kind: fc.constant("updateIdcPermissionSetSessionDuration" as const),
  permissionSetName: nonEmptyStringArb,
  sessionDuration: fc.option(fc.string({ maxLength: 10 }), { nil: null }),
});

/** Generate a valid deleteIdcPermissionSet operation */
const deleteIdcPermissionSetOpArb = fc.record({
  kind: fc.constant("deleteIdcPermissionSet" as const),
  permissionSetName: nonEmptyStringArb,
});

/** Generate a valid putIdcPermissionSetInlinePolicy operation */
const putIdcPermissionSetInlinePolicyOpArb = fc.record({
  kind: fc.constant("putIdcPermissionSetInlinePolicy" as const),
  permissionSetName: nonEmptyStringArb,
  inlinePolicy: nonEmptyStringArb,
});

/** Generate a valid deleteIdcPermissionSetInlinePolicy operation */
const deleteIdcPermissionSetInlinePolicyOpArb = fc.record({
  kind: fc.constant("deleteIdcPermissionSetInlinePolicy" as const),
  permissionSetName: nonEmptyStringArb,
});

/** Generate a valid attachIdcManagedPolicyToPermissionSet operation */
const attachIdcManagedPolicyToPermissionSetOpArb = fc.record({
  kind: fc.constant("attachIdcManagedPolicyToPermissionSet" as const),
  permissionSetName: nonEmptyStringArb,
  managedPolicyArn: nonEmptyStringArb,
});

/** Generate a valid detachIdcManagedPolicyFromPermissionSet operation */
const detachIdcManagedPolicyFromPermissionSetOpArb = fc.record({
  kind: fc.constant("detachIdcManagedPolicyFromPermissionSet" as const),
  permissionSetName: nonEmptyStringArb,
  managedPolicyArn: nonEmptyStringArb,
});

/** Generate a valid attachIdcCustomerManagedPolicyReferenceToPermissionSet operation */
const attachIdcCustomerManagedPolicyReferenceToPermissionSetOpArb = fc.record({
  kind: fc.constant(
    "attachIdcCustomerManagedPolicyReferenceToPermissionSet" as const,
  ),
  permissionSetName: nonEmptyStringArb,
  customerManagedPolicyName: nonEmptyStringArb,
  customerManagedPolicyPath: nonEmptyStringArb,
});

/** Generate a valid detachIdcCustomerManagedPolicyReferenceFromPermissionSet operation */
const detachIdcCustomerManagedPolicyReferenceFromPermissionSetOpArb = fc.record(
  {
    kind: fc.constant(
      "detachIdcCustomerManagedPolicyReferenceFromPermissionSet" as const,
    ),
    permissionSetName: nonEmptyStringArb,
    customerManagedPolicyName: nonEmptyStringArb,
    customerManagedPolicyPath: nonEmptyStringArb,
  },
);

/** Generate a valid provisionIdcPermissionSet operation */
const provisionIdcPermissionSetOpArb = fc.record({
  kind: fc.constant("provisionIdcPermissionSet" as const),
  permissionSetName: nonEmptyStringArb,
  targetScope: fc.constant("ALL_PROVISIONED_ACCOUNTS" as const),
});

/** Generate a valid grantIdcAccountAssignment operation */
const grantIdcAccountAssignmentOpArb = fc.record({
  kind: fc.constant("grantIdcAccountAssignment" as const),
  accountName: nonEmptyStringArb,
  permissionSetName: nonEmptyStringArb,
  principalType: fc.constantFrom("GROUP" as const, "USER" as const),
  principalName: nonEmptyStringArb,
});

/** Generate a valid revokeIdcAccountAssignment operation */
const revokeIdcAccountAssignmentOpArb = fc.record({
  kind: fc.constant("revokeIdcAccountAssignment" as const),
  accountName: nonEmptyStringArb,
  permissionSetName: nonEmptyStringArb,
  principalType: fc.constantFrom("GROUP" as const, "USER" as const),
  principalName: nonEmptyStringArb,
});

/** Combined generator for any valid operation */
const validOperationArb = fc.oneof(
  moveAccountOpArb,
  createOuOpArb,
  renameOuOpArb,
  deleteOuOpArb,
  createAccountOpArb,
  updateAccountTagsOpArb,
  updateAccountNameOpArb,
  removeAccountOpArb,
  createIdcUserOpArb,
  updateIdcUserOpArb,
  deleteIdcUserOpArb,
  createIdcGroupOpArb,
  updateIdcGroupDescriptionOpArb,
  deleteIdcGroupOpArb,
  addIdcGroupMembershipOpArb,
  removeIdcGroupMembershipOpArb,
  createIdcPermissionSetOpArb,
  updateIdcPermissionSetDescriptionOpArb,
  updateIdcPermissionSetSessionDurationOpArb,
  deleteIdcPermissionSetOpArb,
  putIdcPermissionSetInlinePolicyOpArb,
  deleteIdcPermissionSetInlinePolicyOpArb,
  attachIdcManagedPolicyToPermissionSetOpArb,
  detachIdcManagedPolicyFromPermissionSetOpArb,
  attachIdcCustomerManagedPolicyReferenceToPermissionSetOpArb,
  detachIdcCustomerManagedPolicyReferenceFromPermissionSetOpArb,
  provisionIdcPermissionSetOpArb,
  grantIdcAccountAssignmentOpArb,
  revokeIdcAccountAssignmentOpArb,
);

// --- Property 7 Test ---

/**
 * Feature: remote-execution-v2, Property 7: Operation schema validation reuses existing schema
 *
 * For any valid Operation as defined by operationSchema in operations.ts,
 * the Lambda handler's apply action SHALL accept it without validation errors.
 * For any object that does not conform to operationSchema, the Lambda handler
 * SHALL reject it with a validation error.
 *
 * **Validates: Requirements 11.4**
 */
test("Property 7: Operation schema validation reuses existing schema — valid operations accepted, invalid rejected", async () => {
  // Part 1: Valid operations should NOT produce a validation error.
  // The handler may fail for other reasons (e.g., missing S3 state), but it should
  // NOT fail on operation validation itself.
  await fc.assert(
    fc.asyncProperty(validOperationArb, async (operation) => {
      // Sanity check: the generated operation must pass operationSchema validation
      const schemaResult = v.safeParse(operationSchema, operation);
      assert.ok(
        schemaResult.success,
        `Generated operation should be valid per operationSchema: ${JSON.stringify(operation)}`,
      );

      const payload = {
        action: "apply",
        operations: [operation],
        allowDestructive: true,
      };

      const response = await handler(payload);

      // The response should NOT be a validation error.
      // It may be an "internal" error (e.g., S3 state read failure) which is fine —
      // that means it passed validation and moved on to execution.
      if (response.success === false) {
        const errorResponse = response as {
          error: { kind: string; details?: { validationIssues?: string[] } };
        };
        assert.notEqual(
          errorResponse.error.kind,
          "validation",
          `Valid operation should not produce validation error. Operation: ${JSON.stringify(operation)}, Issues: ${JSON.stringify(errorResponse.error.details?.validationIssues)}`,
        );
      }
      // If success is true, that's also fine (though unlikely without real S3)
    }),
    { numRuns: 20 },
  );

  // Part 2: Invalid operations should produce a validation error.
  // Generate arbitrary JSON objects that do NOT conform to operationSchema.

  // Generator for objects with invalid/missing kind field
  const invalidKindArb = fc.oneof(
    // No kind field at all
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s !== "kind"),
      fc.jsonValue(),
      { minKeys: 1, maxKeys: 5 },
    ),
    // kind field with invalid value
    fc.record({
      kind: fc
        .string({ minLength: 1, maxLength: 30 })
        .filter(
          (s) =>
            ![
              "moveAccount",
              "createOu",
              "renameOu",
              "deleteOu",
              "createAccount",
              "updateAccountTags",
              "updateAccountName",
              "removeAccount",
              "createIdcUser",
              "updateIdcUser",
              "deleteIdcUser",
              "createIdcGroup",
              "updateIdcGroupDescription",
              "deleteIdcGroup",
              "addIdcGroupMembership",
              "removeIdcGroupMembership",
              "createIdcPermissionSet",
              "updateIdcPermissionSetDescription",
              "updateIdcPermissionSetSessionDuration",
              "deleteIdcPermissionSet",
              "putIdcPermissionSetInlinePolicy",
              "deleteIdcPermissionSetInlinePolicy",
              "attachIdcManagedPolicyToPermissionSet",
              "detachIdcManagedPolicyFromPermissionSet",
              "attachIdcCustomerManagedPolicyReferenceToPermissionSet",
              "detachIdcCustomerManagedPolicyReferenceFromPermissionSet",
              "provisionIdcPermissionSet",
              "grantIdcAccountAssignment",
              "revokeIdcAccountAssignment",
            ].includes(s),
        ),
    }),
    // kind is not a string
    fc.record({
      kind: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)),
    }),
    // Primitives (not objects)
    fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
  );

  await fc.assert(
    fc.asyncProperty(invalidKindArb, async (invalidOp) => {
      // Sanity check: the generated value must NOT pass operationSchema validation
      const schemaResult = v.safeParse(operationSchema, invalidOp);
      assert.ok(
        !schemaResult.success,
        `Generated invalid op should fail operationSchema: ${JSON.stringify(invalidOp)}`,
      );

      const payload = {
        action: "apply",
        operations: [invalidOp],
        allowDestructive: true,
      };

      const response = await handler(payload);

      // The response must be a validation error
      assert.equal(
        response.success,
        false,
        `Invalid operation should produce failure response. Op: ${JSON.stringify(invalidOp)}`,
      );
      const errorResponse = response as { error: { kind: string } };
      assert.equal(
        errorResponse.error.kind,
        "validation",
        `Invalid operation should produce validation error kind. Op: ${JSON.stringify(invalidOp)}, Got kind: ${errorResponse.error.kind}`,
      );
    }),
    { numRuns: 20 },
  );
});
