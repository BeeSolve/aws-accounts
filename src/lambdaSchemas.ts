import * as v from "valibot";

import { operationSchema } from "./operations.js";
import { stateSchema } from "./state.js";

const validStackSetNames = ["security-setup", "config-recorder", "guardduty-member"] as const;
const stackSetNameSchema = v.picklist(validStackSetNames);

const scanRequestSchema = v.strictObject({
  action: v.literal("scan"),
});

const getStateUrlRequestSchema = v.strictObject({
  action: v.literal("getStateUrl"),
});

const applyRequestSchema = v.strictObject({
  action: v.literal("apply"),
  operations: v.pipe(v.array(operationSchema), v.minLength(1)),
  allowDestructive: v.boolean(),
});

const getUploadUrlRequestSchema = v.strictObject({
  action: v.literal("getUploadUrl"),
  stackSetName: stackSetNameSchema,
});

const deployStackSetRequestSchema = v.strictObject({
  action: v.literal("deployStackSet"),
  stackSetName: stackSetNameSchema,
  targets: v.array(v.string()),
  parameters: v.array(
    v.strictObject({
      key: v.string(),
      value: v.string(),
    }),
  ),
  regions: v.array(v.string()),
  waitForCompletion: v.optional(v.boolean()),
});

const createConfigDeliveryBucketRequestSchema = v.strictObject({
  action: v.literal("createConfigDeliveryBucket"),
  targetAccountId: v.string(),
  bucketName: v.string(),
  region: v.string(),
});

const recordDeployedStackSetsRequestSchema = v.strictObject({
  action: v.literal("recordDeployedStackSets"),
  stackSets: v.array(
    v.strictObject({
      name: v.string(),
      targets: v.array(v.string()),
    }),
  ),
  pendingOperations: v.optional(
    v.array(
      v.strictObject({
        stackSetName: v.string(),
        operationId: v.string(),
        startedAt: v.string(),
      }),
    ),
  ),
});

const createConfigAggregatorRequestSchema = v.strictObject({
  action: v.literal("createConfigAggregator"),
  targetAccountId: v.string(),
  region: v.string(),
});

const checkPendingStackSetsRequestSchema = v.strictObject({
  action: v.literal("checkPendingStackSets"),
  operations: v.array(
    v.strictObject({
      stackSetName: v.string(),
      operationId: v.string(),
    }),
  ),
});

const createCloudTrailBucketRequestSchema = v.strictObject({
  action: v.literal("createCloudTrailBucket"),
  targetAccountId: v.string(),
  bucketName: v.string(),
  region: v.string(),
  organizationId: v.string(),
});

const createOrgTrailRequestSchema = v.strictObject({
  action: v.literal("createOrgTrail"),
  bucketName: v.string(),
  region: v.string(),
});

export const lambdaRequestSchema = v.variant("action", [
  scanRequestSchema,
  getStateUrlRequestSchema,
  applyRequestSchema,
  getUploadUrlRequestSchema,
  deployStackSetRequestSchema,
  createConfigDeliveryBucketRequestSchema,
  recordDeployedStackSetsRequestSchema,
  createConfigAggregatorRequestSchema,
  checkPendingStackSetsRequestSchema,
  createCloudTrailBucketRequestSchema,
  createOrgTrailRequestSchema,
]);

export type LambdaRequestPayload = v.InferOutput<typeof lambdaRequestSchema>;

const scanResponseSchema = v.strictObject({
  action: v.literal("scan"),
  success: v.literal(true),
  summary: v.strictObject({
    organizationalUnits: v.number(),
    accounts: v.number(),
    users: v.number(),
    groups: v.number(),
    permissionSets: v.number(),
    accountAssignments: v.number(),
    policies: v.number(),
    policyAttachments: v.number(),
  }),
  state: stateSchema,
});

const getStateUrlResponseSchema = v.strictObject({
  action: v.literal("getStateUrl"),
  success: v.literal(true),
  url: v.string(),
  expiresInSeconds: v.number(),
});

const applySuccessResponseSchema = v.strictObject({
  action: v.literal("apply"),
  success: v.literal(true),
  operationsCompleted: v.number(),
  state: stateSchema,
});

const errorResponseSchema = v.strictObject({
  success: v.literal(false),
  error: v.strictObject({
    kind: v.picklist(["validation", "concurrencyConflict", "operationFailed", "internal"]),
    message: v.string(),
    details: v.optional(
      v.strictObject({
        failedOperation: v.optional(v.number()),
        operationsCompleted: v.optional(v.number()),
        partialState: v.optional(stateSchema),
        validationIssues: v.optional(v.array(v.string())),
      }),
    ),
  }),
});

const getUploadUrlResponseSchema = v.strictObject({
  action: v.literal("getUploadUrl"),
  success: v.literal(true),
  url: v.string(),
  expiresInSeconds: v.number(),
});

const deployStackSetResponseSchema = v.strictObject({
  action: v.literal("deployStackSet"),
  success: v.literal(true),
  stackSetId: v.string(),
  operationId: v.string(),
});

const createConfigDeliveryBucketResponseSchema = v.strictObject({
  action: v.literal("createConfigDeliveryBucket"),
  success: v.literal(true),
  bucketName: v.string(),
  created: v.boolean(),
});

const recordDeployedStackSetsResponseSchema = v.strictObject({
  action: v.literal("recordDeployedStackSets"),
  success: v.literal(true),
});

const createConfigAggregatorResponseSchema = v.strictObject({
  action: v.literal("createConfigAggregator"),
  success: v.literal(true),
});

const checkPendingStackSetsResponseSchema = v.strictObject({
  action: v.literal("checkPendingStackSets"),
  success: v.literal(true),
  results: v.array(
    v.strictObject({
      stackSetName: v.string(),
      operationId: v.string(),
      status: v.string(),
    }),
  ),
});

const createCloudTrailBucketResponseSchema = v.strictObject({
  action: v.literal("createCloudTrailBucket"),
  success: v.literal(true),
  bucketName: v.string(),
  created: v.boolean(),
});

const createOrgTrailResponseSchema = v.strictObject({
  action: v.literal("createOrgTrail"),
  success: v.literal(true),
  trailArn: v.string(),
  created: v.boolean(),
});

export const lambdaResponseSchema = v.union([
  scanResponseSchema,
  getStateUrlResponseSchema,
  applySuccessResponseSchema,
  getUploadUrlResponseSchema,
  deployStackSetResponseSchema,
  createConfigDeliveryBucketResponseSchema,
  recordDeployedStackSetsResponseSchema,
  createConfigAggregatorResponseSchema,
  checkPendingStackSetsResponseSchema,
  createCloudTrailBucketResponseSchema,
  createOrgTrailResponseSchema,
  errorResponseSchema,
]);

export type LambdaResponsePayload = v.InferOutput<typeof lambdaResponseSchema>;
