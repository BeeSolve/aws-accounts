import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import {
  CloudFormationClient,
  CreateStackSetCommand,
  UpdateStackSetCommand,
  CreateStackInstancesCommand,
  DescribeStackSetCommand,
} from "@aws-sdk/client-cloudformation";
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
import { executeOperation } from "../applyLogic.js";
import { assertUnreachable } from "../helpers.js";

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

const validStackSetNames = ["config-recorder", "guardduty-member"] as const;
const stackSetNameSchema = v.picklist(validStackSetNames);

const getUploadUrlRequestSchema = v.strictObject({
  action: v.literal("getUploadUrl"),
  stackSetName: stackSetNameSchema,
});

const deployStackSetRequestSchema = v.strictObject({
  action: v.literal("deployStackSet"),
  stackSetName: stackSetNameSchema,
  targets: v.array(v.string()),
  parameters: v.array(v.strictObject({
    key: v.string(),
    value: v.string(),
  })),
  regions: v.array(v.string()),
});

const lambdaRequestSchema = v.variant("action", [
  scanRequestSchema,
  getStateUrlRequestSchema,
  applyRequestSchema,
  getUploadUrlRequestSchema,
  deployStackSetRequestSchema,
]);

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

const lambdaResponseSchema = v.union([
  scanResponseSchema,
  getStateUrlResponseSchema,
  applySuccessResponseSchema,
  getUploadUrlResponseSchema,
  deployStackSetResponseSchema,
  errorResponseSchema,
]);

type LambdaResponse = v.InferOutput<typeof lambdaResponseSchema>;

const STATE_KEY = "state.json";
const PRESIGNED_URL_EXPIRY_SECONDS = 3600;

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

const lambdaLogger = {
  log: (...args: unknown[]) => console.log(...args),
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => console.debug(...args),
  trace: (...args: unknown[]) => console.trace(...args),
};

const s3Client = new S3Client({});
const cloudFormationClient = new CloudFormationClient({});
const organizationsClient = new OrganizationsClient({});
const ssoAdminClient = new SSOAdminClient({});
const identityStoreClient = new IdentitystoreClient({});
const accountClient = new AccountClient({});

export async function handler(event: unknown): Promise<LambdaResponse> {
  try {
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

    if (request.action === "scan") {
      const response = await handleScan({ s3Client, bucket, organizationsClient, ssoAdminClient, identityStoreClient, accountClient });
      return validateResponse(response);
    }
    if (request.action === "getStateUrl") {
      const response = await handleGetStateUrl({ s3Client, bucket });
      return validateResponse(response);
    }
    if (request.action === "apply") {
      const response = await handleApply({
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
      const response = await handleGetUploadUrl({ s3Client, bucket, stackSetName: request.stackSetName });
      return validateResponse(response);
    }
    if (request.action === "deployStackSet") {
      const response = await handleDeployStackSet({
        s3Client,
        cloudFormationClient,
        bucket,
        stackSetName: request.stackSetName,
        targets: request.targets,
        parameters: request.parameters,
        regions: request.regions,
      });
      return validateResponse(response);
    }
    assertUnreachable(request, "Unsupported action in handler.");
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";
    const response = buildErrorResponse("internal", message);
    return validateResponse(response);
  }
}

const UPLOAD_URL_EXPIRY_SECONDS = 60;

function toTemplateS3Key(stackSetName: string): string {
  return `stackset-templates/${stackSetName}.yaml`;
}

async function handleGetUploadUrl(props: {
  s3Client: S3Client;
  bucket: string;
  stackSetName: string;
}): Promise<LambdaResponse> {
  const command = new PutObjectCommand({
    Bucket: props.bucket,
    Key: toTemplateS3Key(props.stackSetName),
  });
  const url = await getSignedUrl(props.s3Client, command, {
    expiresIn: UPLOAD_URL_EXPIRY_SECONDS,
  });
  return {
    action: "getUploadUrl" as const,
    success: true,
    url,
    expiresInSeconds: UPLOAD_URL_EXPIRY_SECONDS,
  };
}

async function handleDeployStackSet(props: {
  s3Client: S3Client;
  cloudFormationClient: CloudFormationClient;
  bucket: string;
  stackSetName: string;
  targets: string[];
  parameters: Array<{ key: string; value: string }>;
  regions: string[];
}): Promise<LambdaResponse> {
  const templateObj = await props.s3Client.send(
    new GetObjectCommand({ Bucket: props.bucket, Key: toTemplateS3Key(props.stackSetName) }),
  );
  const templateBody = await templateObj.Body!.transformToString();

  const cfnParams = props.parameters.map((p) => ({
    ParameterKey: p.key,
    ParameterValue: p.value,
  }));

  let stackSetId: string;
  let operationId: string;

  try {
    await props.cloudFormationClient.send(
      new DescribeStackSetCommand({ StackSetName: props.stackSetName }),
    );
    const updateResult = await props.cloudFormationClient.send(
      new UpdateStackSetCommand({
        StackSetName: props.stackSetName,
        TemplateBody: templateBody,
        Parameters: cfnParams,
        Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
      }),
    );
    stackSetId = props.stackSetName;
    operationId = updateResult.OperationId ?? "update-in-progress";
  } catch (error: unknown) {
    if ((error as { name?: string }).name === "StackSetNotFoundException") {
      const createResult = await props.cloudFormationClient.send(
        new CreateStackSetCommand({
          StackSetName: props.stackSetName,
          TemplateBody: templateBody,
          Parameters: cfnParams,
          PermissionModel: "SERVICE_MANAGED",
          AutoDeployment: { Enabled: true, RetainStacksOnAccountRemoval: false },
          Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
        }),
      );
      stackSetId = createResult.StackSetId ?? props.stackSetName;

      const instanceResult = await props.cloudFormationClient.send(
        new CreateStackInstancesCommand({
          StackSetName: props.stackSetName,
          Regions: props.regions,
          DeploymentTargets: { OrganizationalUnitIds: props.targets },
        }),
      );
      operationId = instanceResult.OperationId ?? "create-in-progress";
    } else {
      throw error;
    }
  }

  return {
    action: "deployStackSet" as const,
    success: true,
    stackSetId,
    operationId,
  };
}

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
    success: false,
    error: {
      kind,
      message,
      ...(details != null ? { details } : {}),
    },
  };
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
            (issue) =>
              `${issue.path?.map((p) => p.key).join(".") ?? "root"}: ${issue.message}`,
          ),
        },
      },
    };
  }
  return result.output;
}

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

async function writeStateToS3(props: {
  s3Client: S3Client;
  bucket: string;
  state: StateFile;
  ifMatch?: string;
}): Promise<void> {
  await props.s3Client.send(new PutObjectCommand({
    Bucket: props.bucket,
    Key: STATE_KEY,
    Body: JSON.stringify(props.state, null, 2),
    ContentType: "application/json",
    IfMatch: props.ifMatch
  }));
}

function isS3PreconditionFailed(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    return (
      error.name === "PreconditionFailed" ||
      error.$metadata?.httpStatusCode === 412
    );
  }
  return false;
}

async function handleScan(props: {
  s3Client: S3Client;
  bucket: string;
  organizationsClient: OrganizationsClient;
  ssoAdminClient: SSOAdminClient;
  identityStoreClient: IdentitystoreClient;
  accountClient: AccountClient;
}): Promise<LambdaResponse> {
  const identityCenterInstanceArn =
    process.env.IDENTITY_CENTER_INSTANCE_ARN || undefined;

  const [organization, identityCenter] = await Promise.all([
    scanOrganization({ organizationsClient: props.organizationsClient, accountClient: props.accountClient }),
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
    success: true,
    url,
    expiresInSeconds: PRESIGNED_URL_EXPIRY_SECONDS,
  };
}

async function handleApply(props: {
  s3Client: S3Client;
  bucket: string;
  operations: Operation[];
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
    const operation = props.operations[i]!;
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
            rootId: workingState.organization.rootId,
          },
        },
        runtime: RUNTIME_DEFAULTS,
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
  | { ok: true; state: StateFile; etag: string }
  | { ok: false; response: LambdaResponse }
> {
  try {
    const result = await readStateFromS3({
      s3Client: props.s3Client,
      bucket: props.bucket,
    });
    return { ok: true, state: result.state, etag: result.etag };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to read state from S3.";
    return { ok: false, response: buildErrorResponse("internal", message) };
  }
}
