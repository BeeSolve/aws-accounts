import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { AccountClient } from "@aws-sdk/client-account";
import * as v from "valibot";
import { operationSchema, type Operation } from "../operations.js";
import {
  stateSchema,
  type StateFile,
  createWorkingState,
  materializeWorkingState,
} from "../state.js";
import { scanOrganization, scanIdentityCenter } from "../scanLogic.js";
import { executeOperation, type ExecuteOperationInput } from "../applyLogic.js";

// --- Request Schemas ---

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

const lambdaRequestSchema = v.variant("action", [
  scanRequestSchema,
  getStateUrlRequestSchema,
  applyRequestSchema,
]);

// --- Response Schemas ---

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
    kind: v.picklist([
      "validation",
      "concurrencyConflict",
      "operationFailed",
      "internal",
    ]),
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

const lambdaResponseSchema = v.union([
  scanResponseSchema,
  getStateUrlResponseSchema,
  applySuccessResponseSchema,
  errorResponseSchema,
]);

type LambdaResponse = v.InferOutput<typeof lambdaResponseSchema>;

// --- Constants ---

const STATE_KEY = "state.json";
const PRESIGNED_URL_EXPIRY_SECONDS = 3600;

// --- Runtime defaults for operation execution ---

const RUNTIME_DEFAULTS = {
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

// --- Logger for Lambda ---

const lambdaLogger = {
  log: (...args: unknown[]) => console.log(...args),
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => console.debug(...args),
  trace: (...args: unknown[]) => console.trace(...args),
};

// --- Helper: build error response ---

function buildErrorResponse(
  kind: "validation" | "concurrencyConflict" | "operationFailed" | "internal",
  message: string,
  details?: {
    failedOperation?: number;
    operationsCompleted?: number;
    partialState?: StateFile;
    validationIssues?: string[];
  },
): LambdaResponse {
  return {
    // todo: why there is as const on literal boolean?
    success: false as const,
    error: {
      kind,
      message,
      ...(details != null ? { details } : {}),
    },
  };
}

// --- Helper: validate and return response ---

function validateResponse(response: LambdaResponse): LambdaResponse {
  const result = v.safeParse(lambdaResponseSchema, response);
  if (!result.success) {
    // If response validation fails, return an internal error instead
    return {
      success: false as const,
      error: {
        kind: "internal" as const,
        message: "Response validation failed before returning.",
        details: {
          validationIssues: result.issues.map(
            (issue) =>
              `${issue.path?.map((p) => p.key).join(".") ?? "root"}: ${issue.message}`,
          ),
        },
      },
    };
  }
  return result.output;
}

// --- Helper: read state from S3 ---

async function readStateFromS3(props: {
  s3Client: S3Client;
  bucket: string;
}): Promise<{ state: StateFile; etag: string }> {
  const response = await props.s3Client.send(
    new GetObjectCommand({
      Bucket: props.bucket,
      Key: STATE_KEY,
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

// --- Helper: write state to S3 ---

async function writeStateToS3(props: {
  s3Client: S3Client;
  bucket: string;
  state: StateFile;
  ifMatch?: string;
}): Promise<void> {
  const putParams: {
    Bucket: string;
    Key: string;
    Body: string;
    ContentType: string;
    IfMatch?: string;
  } = {
    Bucket: props.bucket,
    Key: STATE_KEY,
    Body: JSON.stringify(props.state, null, 2),
    ContentType: "application/json",
  };
  if (props.ifMatch != null) {
    putParams.IfMatch = props.ifMatch;
  }
  await props.s3Client.send(new PutObjectCommand(putParams));
}

// --- Helper: check if error is S3 PreconditionFailed ---

function isS3PreconditionFailed(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    return (
      error.name === "PreconditionFailed" ||
      error.$metadata?.httpStatusCode === 412
    );
  }
  return false;
}

// --- Action: scan ---

async function handleScan(props: {
  s3Client: S3Client;
  bucket: string;
}): Promise<LambdaResponse> {
  // todo: pass all of these through props -> the clients in handler should be create outside of handler so they are being reused
  const organizationsClient = new OrganizationsClient({});
  const ssoAdminClient = new SSOAdminClient({});
  const identityStoreClient = new IdentitystoreClient({});

  const identityCenterInstanceArn =
    process.env.IDENTITY_CENTER_INSTANCE_ARN || undefined;

    // todo: parallelize
  const organization = await scanOrganization({ organizationsClient });
  const identityCenter = await scanIdentityCenter({
    ssoAdminClient,
    identityStoreClient,
    requestedInstanceArn: identityCenterInstanceArn,
  });

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
    },
    state,
  };
}

// --- Action: getStateUrl ---

async function handleGetStateUrl(props: {
  s3Client: S3Client;
  bucket: string;
}): Promise<LambdaResponse> {
  const command = new GetObjectCommand({
    Bucket: props.bucket,
    Key: STATE_KEY,
  });

  const url = await getSignedUrl(props.s3Client, command, {
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
  });

  return {
    action: "getStateUrl" as const,
    // todo: as const shouldn't be here
    success: true as const,
    url,
    expiresInSeconds: PRESIGNED_URL_EXPIRY_SECONDS,
  };
}

// --- Action: apply ---

async function handleApply(props: {
  s3Client: S3Client;
  bucket: string;
  operations: Operation[];
  allowDestructive: boolean;
}): Promise<LambdaResponse> {
  // Read current state from S3
  let currentState: StateFile;
  let etag: string;
  try {
    const result = await readStateFromS3({
      s3Client: props.s3Client,
      bucket: props.bucket,
    });
    currentState = result.state;
    etag = result.etag;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to read state from S3.";
    return buildErrorResponse("internal", message);
  }

  // todo: shouldn't be here but passed through props and outside of handler
  // Create AWS clients for operation execution
  const organizationsClient = new OrganizationsClient({});
  const accountClient = new AccountClient({});
  const ssoAdminClient = new SSOAdminClient({});
  const identityStoreClient = new IdentitystoreClient({});

  // Execute operations sequentially
  let workingState = createWorkingState({ state: currentState });
  let operationsCompleted = 0;

  for (let i = 0; i < props.operations.length; i++) {
    const operation = props.operations[i]!;
    try {
      workingState = await executeOperation({
        state: workingState,
        organizationsClient,
        accountClient,
        ssoAdminClient,
        identityStoreClient,
        logger: lambdaLogger,
        context: {
          organization: {
            rootId: workingState.organization.rootId,
          },
        },
        runtime: RUNTIME_DEFAULTS,
        operation,
      });
      operationsCompleted++;
    } catch (error: unknown) {
      // Operation failed — write partial state and return error
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
        // If partial state write fails for other reasons, still report the operation failure
        lambdaLogger.error(
          "Failed to write partial state after operation failure:",
          writeError,
        );
      }

      const errorMessage =
        error instanceof Error ? error.message : "Unknown operation error";
      return buildErrorResponse("operationFailed", errorMessage, {
        failedOperation: i,
        operationsCompleted,
        partialState,
      });
    }
  }

  // All operations succeeded — write final state with conditional write
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

// --- Main Handler ---

export async function handler(event: unknown): Promise<LambdaResponse> {
  try {
    // Validate incoming event
    const parseResult = v.safeParse(lambdaRequestSchema, event);
    if (!parseResult.success) {
      const issues = parseResult.issues.map(
        (issue) =>
          `${issue.path?.map((p) => p.key).join(".") ?? "root"}: ${issue.message}`,
      );
      const response = buildErrorResponse(
        "validation",
        "Invalid request payload.",
        { validationIssues: issues },
      );
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

    const s3Client = new S3Client({});

    // Route to action handler
    let response: LambdaResponse;
    // todo: use assert unreachable pattern here
    switch (request.action) {
      case "scan":
        response = await handleScan({ s3Client, bucket });
        break;
      case "getStateUrl":
        response = await handleGetStateUrl({ s3Client, bucket });
        break;
      case "apply":
        response = await handleApply({
          s3Client,
          bucket,
          operations: request.operations,
          allowDestructive: request.allowDestructive,
        });
        break;
    }

    return validateResponse(response);
  } catch (error: unknown) {
    // Catch-all for unexpected errors
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";
    const response = buildErrorResponse("internal", message);
    return validateResponse(response);
  }
}
