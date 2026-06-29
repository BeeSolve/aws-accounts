import { AccountClient } from "@aws-sdk/client-account";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { S3Client } from "@aws-sdk/client-s3";
import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { STSClient } from "@aws-sdk/client-sts";
import * as v from "valibot";

import { assertUnreachable } from "../helpers.js";
import {
  lambdaRequestSchema,
  lambdaResponseSchema,
  type LambdaResponsePayload,
} from "../lambdaSchemas.js";
import { buildErrorResponse } from "./helpers.js";
import {
  createCloudTrailBucket,
  createConfigAggregator,
  createConfigDeliveryBucket,
  createOrgTrail,
} from "./security.js";
import {
  checkPendingStackSets,
  deployStackSet,
  getUploadUrl,
  recordDeployedStackSets,
} from "./stackSets.js";
import { apply, getStateUrl, scan } from "./state.js";

type LambdaResponse = LambdaResponsePayload;

const s3Client = new S3Client({});
const stsClient = new STSClient({});
const cloudFormationClient = new CloudFormationClient({});
const organizationsClient = new OrganizationsClient({});
const ssoAdminClient = new SSOAdminClient({});
const identityStoreClient = new IdentitystoreClient({});
const accountClient = new AccountClient({});

const managedByTag = { Key: "ManagedBy", Value: "beesolve-aws-accounts" };

export async function handler(event: unknown): Promise<LambdaResponse> {
  try {
    const parseResult = v.safeParse(lambdaRequestSchema, event);
    if (!parseResult.success) {
      const issues = parseResult.issues.map(
        (issue) => `${issue.path?.map((p) => p.key).join(".") ?? "root"}: ${issue.message}`,
      );
      const response = buildErrorResponse("validation", "Invalid request payload.", {
        validationIssues: issues,
      });
      return validateResponse(response);
    }

    const request = parseResult.output;
    const bucket = process.env.STATE_BUCKET_NAME;
    if (bucket == null || bucket.length === 0) {
      const response = buildErrorResponse(
        "internal",
        "STATE_BUCKET_NAME environment variable is not configured.",
      );
      return validateResponse(response);
    }

    if (request.action === "scan") {
      const response = await scan({
        s3Client,
        bucket,
        organizationsClient,
        ssoAdminClient,
        identityStoreClient,
        accountClient,
      });
      return validateResponse(response);
    }
    if (request.action === "getStateUrl") {
      const response = await getStateUrl({ s3Client, bucket });
      return validateResponse(response);
    }
    if (request.action === "apply") {
      const response = await apply({
        s3Client,
        bucket,
        operations: request.operations,
        allowDestructive: request.allowDestructive,
        organizationsClient,
        ssoAdminClient,
        identityStoreClient,
        accountClient,
      });
      return validateResponse(response);
    }
    if (request.action === "getUploadUrl") {
      const response = await getUploadUrl({
        s3Client,
        bucket,
        stackSetName: request.stackSetName,
      });
      return validateResponse(response);
    }
    if (request.action === "deployStackSet") {
      const response = await deployStackSet({
        s3Client,
        cloudFormationClient,
        bucket,
        stackSetName: request.stackSetName,
        targets: request.targets,
        parameters: request.parameters,
        regions: request.regions,
        waitForCompletion: request.waitForCompletion ?? false,
        managedByTag,
      });
      return validateResponse(response);
    }
    if (request.action === "createConfigDeliveryBucket") {
      const response = await createConfigDeliveryBucket({
        targetAccountId: request.targetAccountId,
        bucketName: request.bucketName,
        region: request.region,
        organizationsClient,
        managedByTag,
        stsClient,
      });
      return validateResponse(response);
    }
    if (request.action === "recordDeployedStackSets") {
      const response = await recordDeployedStackSets({
        s3Client,
        bucket,
        stackSets: request.stackSets,
        pendingOperations: request.pendingOperations,
      });
      return validateResponse(response);
    }
    if (request.action === "createConfigAggregator") {
      const response = await createConfigAggregator({
        targetAccountId: request.targetAccountId,
        region: request.region,
        stsClient,
      });
      return validateResponse(response);
    }
    if (request.action === "checkPendingStackSets") {
      const response = await checkPendingStackSets({
        cloudFormationClient,
        operations: request.operations,
      });
      return validateResponse(response);
    }
    if (request.action === "createCloudTrailBucket") {
      const response = await createCloudTrailBucket({
        targetAccountId: request.targetAccountId,
        bucketName: request.bucketName,
        region: request.region,
        organizationId: request.organizationId,
        managedByTag,
        stsClient,
      });
      return validateResponse(response);
    }
    if (request.action === "createOrgTrail") {
      const response = await createOrgTrail({
        bucketName: request.bucketName,
        region: request.region,
      });
      return validateResponse(response);
    }
    assertUnreachable(request, "Unsupported action in handler.");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "An unexpected error occurred.";
    const response = buildErrorResponse("internal", message);
    return validateResponse(response);
  }
}

function validateResponse(response: LambdaResponse): LambdaResponse {
  const result = v.safeParse(lambdaResponseSchema, response);
  if (!result.success) {
    return {
      success: false as const,
      error: {
        kind: "internal" as const,
        message: "Response validation failed before returning.",
        details: {
          validationIssues: result.issues.map(
            (issue) => `${issue.path?.map(({ key }) => key).join(".") ?? "root"}: ${issue.message}`,
          ),
        },
      },
    };
  }
  return result.output;
}
