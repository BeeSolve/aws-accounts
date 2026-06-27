import { AccountClient } from "@aws-sdk/client-account";
import {
  CloudFormationClient,
  CreateStackSetCommand,
  UpdateStackSetCommand,
  CreateStackInstancesCommand,
  DescribeStackSetCommand,
  DescribeStackSetOperationCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CloudTrailClient,
  CreateTrailCommand,
  GetTrailCommand,
  StartLoggingCommand,
  UpdateTrailCommand,
} from "@aws-sdk/client-cloudtrail";
import {
  ConfigServiceClient,
  PutConfigurationAggregatorCommand,
} from "@aws-sdk/client-config-service";
import { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { DescribeOrganizationCommand, OrganizationsClient } from "@aws-sdk/client-organizations";
import {
  CreateBucketCommand,
  GetObjectCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as v from "valibot";

import { executeOperation } from "../applyLogic.js";
import { assertUnreachable } from "../helpers.js";
import {
  lambdaRequestSchema,
  lambdaResponseSchema,
  type LambdaResponsePayload,
} from "../lambdaSchemas.js";
import { operationSchema, type Operation } from "../operations.js";
import { scanOrganization, scanIdentityCenter } from "../scanLogic.js";
import {
  stateSchema,
  type StateFile,
  createWorkingState,
  materializeWorkingState,
} from "../state.js";

const assumedCredentialsSchema = v.strictObject({
  AccessKeyId: v.string(),
  SecretAccessKey: v.string(),
  SessionToken: v.string(),
});

type LambdaResponse = LambdaResponsePayload;

async function assumeRoleIntoAccount(props: {
  targetAccountId: string;
  sessionName: string;
}): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  const assumeResult = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${props.targetAccountId}:role/BeesolveSecuritySetupRole`,
      RoleSessionName: props.sessionName,
    }),
  );
  const credentials = v.parse(assumedCredentialsSchema, assumeResult.Credentials);
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
  };
}

const stateKey = "state.json";
const managedByTag = { Key: "ManagedBy", Value: "beesolve-aws-accounts" };
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

const s3Client = new S3Client({});
const cloudFormationClient = new CloudFormationClient({});
const stsClient = new STSClient({});
const organizationsClient = new OrganizationsClient({});
const ssoAdminClient = new SSOAdminClient({});
const identityStoreClient = new IdentitystoreClient({});
const accountClient = new AccountClient({});

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
      const response = await handleScan({
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
      const response = await handleGetUploadUrl({
        s3Client,
        bucket,
        stackSetName: request.stackSetName,
      });
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
        waitForCompletion: request.waitForCompletion ?? false,
      });
      return validateResponse(response);
    }
    if (request.action === "createConfigDeliveryBucket") {
      const response = await handleCreateConfigDeliveryBucket({
        targetAccountId: request.targetAccountId,
        bucketName: request.bucketName,
        region: request.region,
        organizationsClient,
      });
      return validateResponse(response);
    }
    if (request.action === "recordDeployedStackSets") {
      const response = await handleRecordDeployedStackSets({
        s3Client,
        bucket,
        stackSets: request.stackSets,
        pendingOperations: request.pendingOperations,
      });
      return validateResponse(response);
    }
    if (request.action === "createConfigAggregator") {
      const response = await handleCreateConfigAggregator({
        targetAccountId: request.targetAccountId,
        region: request.region,
      });
      return validateResponse(response);
    }
    if (request.action === "checkPendingStackSets") {
      const response = await handleCheckPendingStackSets({
        cloudFormationClient,
        operations: request.operations,
      });
      return validateResponse(response);
    }
    if (request.action === "createCloudTrailBucket") {
      const response = await handleCreateCloudTrailBucket({
        targetAccountId: request.targetAccountId,
        bucketName: request.bucketName,
        region: request.region,
        organizationId: request.organizationId,
      });
      return validateResponse(response);
    }
    if (request.action === "createOrgTrail") {
      const response = await handleCreateOrgTrail({
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

const uploadUrlExpirySeconds = 60;

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
    expiresIn: uploadUrlExpirySeconds,
  });
  return {
    action: "getUploadUrl" as const,
    success: true,
    url,
    expiresInSeconds: uploadUrlExpirySeconds,
  };
}

async function handleDeployStackSet(props: {
  s3Client: S3Client;
  cloudFormationClient: CloudFormationClient;
  bucket: string;
  stackSetName: string;
  targets: Array<string>;
  parameters: Array<{ key: string; value: string }>;
  regions: Array<string>;
  waitForCompletion: boolean;
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
    try {
      await props.cloudFormationClient.send(
        new UpdateStackSetCommand({
          StackSetName: props.stackSetName,
          TemplateBody: templateBody,
          Parameters: cfnParams,
          Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
        }),
      );
    } catch (updateError: unknown) {
      const name = (updateError as { name?: string }).name;
      if (name !== "OperationInProgressException") throw updateError;
    }
    stackSetId = props.stackSetName;
    try {
      const instanceResult = await props.cloudFormationClient.send(
        new CreateStackInstancesCommand({
          StackSetName: props.stackSetName,
          Regions: props.regions,
          DeploymentTargets: { OrganizationalUnitIds: props.targets },
        }),
      );
      operationId = instanceResult.OperationId ?? "update-in-progress";
    } catch (instanceError: unknown) {
      // Instances may already exist — treat as success
      operationId = "instances-already-exist";
    }
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
          Tags: [managedByTag],
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

  // Wait for the operation to complete
  if (props.waitForCompletion && operationId !== "instances-already-exist") {
    for (let i = 0; i < 60; i++) {
      const opStatus = await props.cloudFormationClient.send(
        new DescribeStackSetOperationCommand({
          StackSetName: props.stackSetName,
          OperationId: operationId,
        }),
      );
      const status = opStatus.StackSetOperation?.Status;
      if (status === "SUCCEEDED") break;
      if (status === "FAILED" || status === "STOPPED") {
        throw new Error(`StackSet operation ${operationId} ${status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  return {
    action: "deployStackSet" as const,
    success: true,
    stackSetId,
    operationId,
  };
}

async function createManagedBucket(props: {
  s3Client: S3Client;
  bucketName: string;
  region: string;
  purposeTag: string;
  policy: string;
}): Promise<boolean> {
  let created = false;
  try {
    await props.s3Client.send(
      new CreateBucketCommand({
        Bucket: props.bucketName,
        ...(props.region !== "us-east-1" && {
          CreateBucketConfiguration: { LocationConstraint: props.region as any },
        }),
      }),
    );
    created = true;
  } catch (error: unknown) {
    const name = (error as { name?: string }).name;
    if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") {
      throw error;
    }
  }

  await props.s3Client.send(
    new PutPublicAccessBlockCommand({
      Bucket: props.bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    }),
  );

  await props.s3Client.send(
    new PutBucketTaggingCommand({
      Bucket: props.bucketName,
      Tagging: { TagSet: [managedByTag, { Key: "Purpose", Value: props.purposeTag }] },
    }),
  );

  await props.s3Client.send(
    new PutBucketPolicyCommand({
      Bucket: props.bucketName,
      Policy: props.policy,
    }),
  );

  return created;
}

async function handleCreateConfigDeliveryBucket(props: {
  targetAccountId: string;
  bucketName: string;
  region: string;
  organizationsClient: OrganizationsClient;
}): Promise<LambdaResponse> {
  const orgResponse = await props.organizationsClient.send(new DescribeOrganizationCommand({}));
  const organizationId = orgResponse.Organization?.Id;
  if (!organizationId) {
    throw new Error("Could not determine organization ID.");
  }

  const credentials = await assumeRoleIntoAccount({
    targetAccountId: props.targetAccountId,
    sessionName: "beesolve-aws-accounts-config-bucket",
  });

  const targetS3 = new S3Client({ region: props.region, credentials });

  const bucketPolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AWSConfigBucketPermissionsCheck",
        Effect: "Allow",
        Principal: { Service: "config.amazonaws.com" },
        Action: "s3:GetBucketAcl",
        Resource: `arn:aws:s3:::${props.bucketName}`,
        Condition: { StringEquals: { "aws:SourceOrgID": organizationId } },
      },
      {
        Sid: "AWSConfigBucketDelivery",
        Effect: "Allow",
        Principal: { Service: "config.amazonaws.com" },
        Action: "s3:PutObject",
        Resource: `arn:aws:s3:::${props.bucketName}/AWSLogs/*/Config/*`,
        Condition: {
          StringEquals: {
            "s3:x-amz-acl": "bucket-owner-full-control",
            "aws:SourceOrgID": organizationId,
          },
        },
      },
    ],
  });

  const created = await createManagedBucket({
    s3Client: targetS3,
    bucketName: props.bucketName,
    region: props.region,
    purposeTag: "config-delivery",
    policy: bucketPolicy,
  });

  return {
    action: "createConfigDeliveryBucket" as const,
    success: true,
    bucketName: props.bucketName,
    created,
  };
}

async function handleCheckPendingStackSets(props: {
  cloudFormationClient: CloudFormationClient;
  operations: Array<{ stackSetName: string; operationId: string }>;
}): Promise<LambdaResponse> {
  const results = await Promise.all(
    props.operations.map(async (op) => {
      try {
        const result = await props.cloudFormationClient.send(
          new DescribeStackSetOperationCommand({
            StackSetName: op.stackSetName,
            OperationId: op.operationId,
          }),
        );
        return {
          stackSetName: op.stackSetName,
          operationId: op.operationId,
          status: result.StackSetOperation?.Status ?? "UNKNOWN",
        };
      } catch {
        return { stackSetName: op.stackSetName, operationId: op.operationId, status: "UNKNOWN" };
      }
    }),
  );
  return { action: "checkPendingStackSets" as const, success: true, results };
}

async function handleCreateConfigAggregator(props: {
  targetAccountId: string;
  region: string;
}): Promise<LambdaResponse> {
  const credentials = await assumeRoleIntoAccount({
    targetAccountId: props.targetAccountId,
    sessionName: "beesolve-aws-accounts-config-aggregator",
  });

  const configClient = new ConfigServiceClient({
    region: props.region,
    credentials,
  });

  await configClient.send(
    new PutConfigurationAggregatorCommand({
      ConfigurationAggregatorName: "OrganizationAggregator",
      OrganizationAggregationSource: {
        AllAwsRegions: true,
        RoleArn: `arn:aws:iam::${props.targetAccountId}:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig`,
      },
    }),
  );

  return { action: "createConfigAggregator" as const, success: true };
}

async function handleCreateCloudTrailBucket(props: {
  targetAccountId: string;
  bucketName: string;
  region: string;
  organizationId: string;
}): Promise<LambdaResponse> {
  const credentials = await assumeRoleIntoAccount({
    targetAccountId: props.targetAccountId,
    sessionName: "beesolve-aws-accounts-cloudtrail-bucket",
  });

  const targetS3 = new S3Client({ region: props.region, credentials });

  const bucketPolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AWSCloudTrailAclCheck",
        Effect: "Allow",
        Principal: { Service: "cloudtrail.amazonaws.com" },
        Action: "s3:GetBucketAcl",
        Resource: `arn:aws:s3:::${props.bucketName}`,
        Condition: { StringEquals: { "aws:SourceOrgID": props.organizationId } },
      },
      {
        Sid: "AWSCloudTrailWrite",
        Effect: "Allow",
        Principal: { Service: "cloudtrail.amazonaws.com" },
        Action: "s3:PutObject",
        Resource: `arn:aws:s3:::${props.bucketName}/AWSLogs/*`,
        Condition: {
          StringEquals: {
            "s3:x-amz-acl": "bucket-owner-full-control",
            "aws:SourceOrgID": props.organizationId,
          },
        },
      },
    ],
  });

  const created = await createManagedBucket({
    s3Client: targetS3,
    bucketName: props.bucketName,
    region: props.region,
    purposeTag: "cloudtrail-logs",
    policy: bucketPolicy,
  });

  return {
    action: "createCloudTrailBucket" as const,
    success: true,
    bucketName: props.bucketName,
    created,
  };
}

async function handleCreateOrgTrail(props: {
  bucketName: string;
  region: string;
}): Promise<LambdaResponse> {
  const cloudTrailClient = new CloudTrailClient({ region: props.region });

  try {
    const existing = await cloudTrailClient.send(
      new GetTrailCommand({ Name: "organization-trail" }),
    );
    await cloudTrailClient.send(
      new UpdateTrailCommand({
        Name: "organization-trail",
        S3BucketName: props.bucketName,
        IsOrganizationTrail: true,
        IsMultiRegionTrail: true,
        EnableLogFileValidation: true,
      }),
    );
    return {
      action: "createOrgTrail" as const,
      success: true,
      trailArn: existing.Trail?.TrailARN ?? "",
      created: false,
    };
  } catch (error: unknown) {
    const name = (error as { name?: string }).name;
    if (name !== "TrailNotFoundException") {
      throw error;
    }
  }

  const createResult = await cloudTrailClient.send(
    new CreateTrailCommand({
      Name: "organization-trail",
      S3BucketName: props.bucketName,
      IsOrganizationTrail: true,
      IsMultiRegionTrail: true,
      EnableLogFileValidation: true,
    }),
  );

  await cloudTrailClient.send(new StartLoggingCommand({ Name: "organization-trail" }));

  return {
    action: "createOrgTrail" as const,
    success: true,
    trailArn: createResult.TrailARN ?? "",
    created: true,
  };
}

async function handleRecordDeployedStackSets(props: {
  s3Client: S3Client;
  bucket: string;
  stackSets: Array<{ name: string; targets: Array<string> }>;
  pendingOperations?: Array<{ stackSetName: string; operationId: string; startedAt: string }>;
}): Promise<LambdaResponse> {
  const stateObj = await props.s3Client.send(
    new GetObjectCommand({ Bucket: props.bucket, Key: stateKey }),
  );
  const state = JSON.parse(await stateObj.Body!.transformToString());
  state.deployedStackSets = props.stackSets;
  state.pendingStackSetOperations = props.pendingOperations?.length
    ? props.pendingOperations
    : undefined;
  await props.s3Client.send(
    new PutObjectCommand({
      Bucket: props.bucket,
      Key: stateKey,
      Body: JSON.stringify(state, null, 2),
      ContentType: "application/json",
    }),
  );
  return { action: "recordDeployedStackSets" as const, success: true };
}

function buildErrorResponse(
  kind: "validation" | "concurrencyConflict" | "operationFailed" | "internal",
  message: string,
  details?: {
    failedOperation?: number;
    operationsCompleted?: number;
    partialState?: StateFile;
    validationIssues?: Array<string>;
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
            (issue) => `${issue.path?.map((p) => p.key).join(".") ?? "root"}: ${issue.message}`,
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

async function writeStateToS3(props: {
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

async function handleScan(props: {
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

async function handleGetStateUrl(props: {
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

async function handleApply(props: {
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
