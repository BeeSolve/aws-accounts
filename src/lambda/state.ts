import type { AccountClient } from "@aws-sdk/client-account";
import type { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import type { OrganizationsClient } from "@aws-sdk/client-organizations";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as v from "valibot";

import { executeOperation } from "../applyLogic.js";
import type { LambdaResponsePayload } from "../lambdaSchemas.js";
import type { Operation } from "../operations.js";
import { scanIdentityCenter, scanOrganization } from "../scanLogic.js";
import type { StateFile } from "../state.js";
import { createWorkingState, materializeWorkingState, stateSchema } from "../state.js";
import { buildErrorResponse, stateKey } from "./helpers.ts";

type LambdaResponse = LambdaResponsePayload;
const presignedUrlExpirySeconds = 3600;

const runtimeDefaults = {
  createAccount: {
    timeoutInMs: 300_000,
    pollIntervalInMs: 5_000,
  },
  accountAssignment: {
    timeoutInMs: 60_000,
    pollIntervalInMs: 2_000,
  },
  permissionSetProvisioning: {
    timeoutInMs: 60_000,
    pollIntervalInMs: 2_000,
  },
};

const lambdaLogger = {
  log: (...args: Array<unknown>) => console.log(...args),
  info: (...args: Array<unknown>) => console.info(...args),
  warn: (...args: Array<unknown>) => console.warn(...args),
  error: (...args: Array<unknown>) => console.error(...args),
  debug: (...args: Array<unknown>) => console.debug(...args),
  trace: (...args: Array<unknown>) => console.trace(...args),
};

export async function scan(props: {
  s3Client: S3Client;
  bucket: string;
  organizationsClient: OrganizationsClient;
  ssoAdminClient: SSOAdminClient;
  identityStoreClient: IdentitystoreClient;
  accountClient: AccountClient;
}): Promise<LambdaResponse> {
  const identityCenterInstanceArn = process.env.IDENTITY_CENTER_INSTANCE_ARN || undefined;

  const [organization, identityCenter] = await Promise.all([
    scanOrganization({
      organizationsClient: props.organizationsClient,
      accountClient: props.accountClient,
    }),
    scanIdentityCenter({
      ssoAdminClient: props.ssoAdminClient,
      identityStoreClient: props.identityStoreClient,
      requestedInstanceArn: identityCenterInstanceArn,
    }),
  ]);

  const state: StateFile = {
    version: "1",
    generatedAt: new Date().toISOString(),
    organization,
    identityCenter,
  };

  await writeStateToS3({
    s3Client: props.s3Client,
    bucket: props.bucket,
    state,
  });

  return {
    action: "scan" as const,
    success: true as const,
    summary: {
      organizationalUnits: state.organization.organizationalUnits.length,
      accounts: state.organization.accounts.length,
      users: state.identityCenter.users.length,
      groups: state.identityCenter.groups.length,
      permissionSets: state.identityCenter.permissionSets.length,
      accountAssignments: state.identityCenter.accountAssignments.length,
      policies: state.organization.policies?.length ?? 0,
      policyAttachments: state.organization.policyAttachments?.length ?? 0,
    },
    state,
  };
}

export async function getStateUrl(props: {
  s3Client: S3Client;
  bucket: string;
}): Promise<LambdaResponse> {
  const command = new GetObjectCommand({
    Bucket: props.bucket,
    Key: stateKey,
  });

  const url = await getSignedUrl(props.s3Client, command, {
    expiresIn: presignedUrlExpirySeconds,
  });

  return {
    action: "getStateUrl" as const,
    success: true,
    url,
    expiresInSeconds: presignedUrlExpirySeconds,
  };
}

export async function apply(props: {
  s3Client: S3Client;
  bucket: string;
  operations: Array<Operation>;
  allowDestructive: boolean;
  organizationsClient: OrganizationsClient;
  ssoAdminClient: SSOAdminClient;
  identityStoreClient: IdentitystoreClient;
  accountClient: AccountClient;
}): Promise<LambdaResponse> {
  const stateResult = await loadStateForApply({
    s3Client: props.s3Client,
    bucket: props.bucket,
  });
  if (!stateResult.ok) {
    return stateResult.response;
  }
  const { state: currentState, etag } = stateResult;

  let workingState = createWorkingState({ state: currentState });
  let operationsCompleted = 0;

  for (let i = 0; i < props.operations.length; i++) {
    const operation = props.operations[i];
    try {
      workingState = await executeOperation({
        state: workingState,
        organizationsClient: props.organizationsClient,
        accountClient: props.accountClient,
        ssoAdminClient: props.ssoAdminClient,
        identityStoreClient: props.identityStoreClient,
        logger: lambdaLogger,
        context: {
          organization: {
            organizationId: workingState.organization.organizationId,
            rootId: workingState.organization.rootId,
          },
        },
        runtime: runtimeDefaults,
        operation,
      });
      operationsCompleted++;
    } catch (error: unknown) {
      const partialState = materializeWorkingState({ workingState });
      try {
        await writeStateToS3({
          s3Client: props.s3Client,
          bucket: props.bucket,
          state: partialState,
          ifMatch: etag,
        });
      } catch (writeError: unknown) {
        if (isS3PreconditionFailed(writeError)) {
          return buildErrorResponse(
            "concurrencyConflict",
            "Concurrent state modification detected while writing partial state.",
          );
        }
        lambdaLogger.error("Failed to write partial state after operation failure:", writeError);
      }

      const errorMessage = error instanceof Error ? error.message : "Unknown operation error";
      return buildErrorResponse("operationFailed", errorMessage, {
        failedOperation: i,
        operationsCompleted,
        partialState,
      });
    }
  }

  const finalState = materializeWorkingState({ workingState });
  try {
    await writeStateToS3({
      s3Client: props.s3Client,
      bucket: props.bucket,
      state: finalState,
      ifMatch: etag,
    });
  } catch (error: unknown) {
    if (isS3PreconditionFailed(error)) {
      return buildErrorResponse(
        "concurrencyConflict",
        "Concurrent state modification detected. Another apply may have completed while this one was running.",
      );
    }
    throw error;
  }

  return {
    action: "apply" as const,
    success: true as const,
    operationsCompleted,
    state: finalState,
  };
}

async function loadStateForApply(props: {
  s3Client: S3Client;
  bucket: string;
}): Promise<
  { ok: true; state: StateFile; etag: string } | { ok: false; response: LambdaResponse }
> {
  try {
    const result = await readStateFromS3({
      s3Client: props.s3Client,
      bucket: props.bucket,
    });
    return { ok: true, state: result.state, etag: result.etag };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to read state from S3.";
    return { ok: false, response: buildErrorResponse("internal", message) };
  }
}

export async function readStateFromS3(props: {
  s3Client: S3Client;
  bucket: string;
}): Promise<{ state: StateFile; etag: string }> {
  const response = await props.s3Client.send(
    new GetObjectCommand({
      Bucket: props.bucket,
      Key: stateKey,
    }),
  );
  const body = await response.Body?.transformToString();
  if (body == null) {
    throw new Error("State not found. Run remote scan first.");
  }
  const parsed = JSON.parse(body);
  const state = v.parse(stateSchema, parsed);
  const etag = response.ETag ?? "";
  return { state, etag };
}

export async function writeStateToS3(props: {
  s3Client: S3Client;
  bucket: string;
  state: StateFile;
  ifMatch?: string;
}): Promise<void> {
  await props.s3Client.send(
    new PutObjectCommand({
      Bucket: props.bucket,
      Key: stateKey,
      Body: JSON.stringify(props.state, null, 2),
      ContentType: "application/json",
      IfMatch: props.ifMatch,
    }),
  );
}

function isS3PreconditionFailed(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    return error.name === "PreconditionFailed" || error.$metadata?.httpStatusCode === 412;
  }
  return false;
}
