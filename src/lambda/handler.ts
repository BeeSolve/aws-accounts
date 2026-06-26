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
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { ConfigServiceClient, PutConfigurationAggregatorCommand } from "@aws-sdk/client-config-service";
import {
  CloudTrailClient,
  CreateTrailCommand,
  GetTrailCommand,
  StartLoggingCommand,
  UpdateTrailCommand,
} from "@aws-sdk/client-cloudtrail";
import {
  CloudFormationClient,
  CreateStackSetCommand,
  UpdateStackSetCommand,
  CreateStackInstancesCommand,
  DescribeStackSetCommand,
  DescribeStackSetOperationCommand,
} from "@aws-sdk/client-cloudformation";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DescribeOrganizationCommand, OrganizationsClient } from "@aws-sdk/client-organizations";
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

const validStackSetNames = [
  "security-setup",
  "config-recorder",
  "guardduty-member",
] as const;
const stackSetNameSchema = v.picklist(validStackSetNames);

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
  stackSets: v.array(v.strictObject({
    name: v.string(),
    targets: v.array(v.string()),
  })),
  pendingOperations: v.optional(v.array(v.strictObject({
    stackSetName: v.string(),
    operationId: v.string(),
    startedAt: v.string(),
  }))),
});

const createConfigAggregatorRequestSchema = v.strictObject({
  action: v.literal("createConfigAggregator"),
  targetAccountId: v.string(),
  region: v.string(),
});

const checkPendingStackSetsRequestSchema = v.strictObject({
  action: v.literal("checkPendingStackSets"),
  operations: v.array(v.strictObject({
    stackSetName: v.string(),
    operationId: v.string(),
  })),
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

const assumedCredentialsSchema = v.strictObject({
  AccessKeyId: v.string(),
  SecretAccessKey: v.string(),
  SessionToken: v.string(),
});

const lambdaRequestSchema = v.variant("action", [
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
  results: v.array(v.strictObject({
    stackSetName: v.string(),
    operationId: v.string(),
    status: v.string(),
  })),
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

const lambdaResponseSchema = v.union([
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

type LambdaResponse = v.InferOutput<typeof lambdaResponseSchema>;

const STATE_KEY = "state.json";
const MANAGED_BY_TAG = { Key: "ManagedBy", Value: "beesolve-aws-accounts" };
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
          Tags: [MANAGED_BY_TAG],
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

  const assumeResult = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${props.targetAccountId}:role/BeesolveSecuritySetupRole`,
      RoleSessionName: "beesolve-aws-accounts-config-bucket",
    }),
  );
  const credentials = v.parse(assumedCredentialsSchema, assumeResult.Credentials);

  const targetS3 = new S3Client({
    region: props.region,
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
  });

  let created = false;
  try {
    await targetS3.send(
      new CreateBucketCommand({
        Bucket: props.bucketName,
        ...(props.region !== "us-east-1" && {
          CreateBucketConfiguration: { LocationConstraint: props.region as any }, //kiro we've already created bucket in this project and we've solved types so you shoudln't use `as any` here
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

  await targetS3.send(
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

  await targetS3.send(new PutBucketTaggingCommand({
    Bucket: props.bucketName,
    Tagging: { TagSet: [MANAGED_BY_TAG, { Key: "Purpose", Value: "config-delivery" }] },
  }));

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

  await targetS3.send(
    new PutBucketPolicyCommand({
      Bucket: props.bucketName,
      Policy: bucketPolicy,
    }),
  );

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
  const assumeResult = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${props.targetAccountId}:role/BeesolveSecuritySetupRole`,
      RoleSessionName: "beesolve-aws-accounts-config-aggregator",
    }),
  );
  const credentials = v.parse(assumedCredentialsSchema, assumeResult.Credentials);

  const configClient = new ConfigServiceClient({
    region: props.region,
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
  });

  await configClient.send(new PutConfigurationAggregatorCommand({
    ConfigurationAggregatorName: "OrganizationAggregator",
    OrganizationAggregationSource: {
      AllAwsRegions: true,
      RoleArn: `arn:aws:iam::${props.targetAccountId}:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig`,
    },
  }));

  return { action: "createConfigAggregator" as const, success: true };
}

async function handleCreateCloudTrailBucket(props: {
  targetAccountId: string;
  bucketName: string;
  region: string;
  organizationId: string;
}): Promise<LambdaResponse> {
  const assumeResult = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${props.targetAccountId}:role/BeesolveSecuritySetupRole`,
      RoleSessionName: "beesolve-aws-accounts-cloudtrail-bucket",
    }),
  );
  const credentials = v.parse(assumedCredentialsSchema, assumeResult.Credentials);

  const targetS3 = new S3Client({
    region: props.region,
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
  });

  let created = false;
  try {
    await targetS3.send(
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

  await targetS3.send(
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

  await targetS3.send(new PutBucketTaggingCommand({
    Bucket: props.bucketName,
    Tagging: { TagSet: [MANAGED_BY_TAG, { Key: "Purpose", Value: "cloudtrail-logs" }] },
  }));

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

  await targetS3.send(
    new PutBucketPolicyCommand({
      Bucket: props.bucketName,
      Policy: bucketPolicy,
    }),
  );

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
    const existing = await cloudTrailClient.send(new GetTrailCommand({ Name: "organization-trail" }));
    await cloudTrailClient.send(new UpdateTrailCommand({
      Name: "organization-trail",
      S3BucketName: props.bucketName,
      IsOrganizationTrail: true,
      IsMultiRegionTrail: true,
      EnableLogFileValidation: true,
    }));
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

  const createResult = await cloudTrailClient.send(new CreateTrailCommand({
    Name: "organization-trail",
    S3BucketName: props.bucketName,
    IsOrganizationTrail: true,
    IsMultiRegionTrail: true,
    EnableLogFileValidation: true,
  }));

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
  stackSets: Array<{ name: string; targets: string[] }>;
  pendingOperations?: Array<{ stackSetName: string; operationId: string; startedAt: string }>;
}): Promise<LambdaResponse> {
  const stateObj = await props.s3Client.send(
    new GetObjectCommand({ Bucket: props.bucket, Key: STATE_KEY }),
  );
  const state = JSON.parse(await stateObj.Body!.transformToString());
  state.deployedStackSets = props.stackSets;
  state.pendingStackSetOperations = props.pendingOperations?.length ? props.pendingOperations : undefined;
  await props.s3Client.send(
    new PutObjectCommand({
      Bucket: props.bucket,
      Key: STATE_KEY,
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
  await props.s3Client.send(
    new PutObjectCommand({
      Bucket: props.bucket,
      Key: STATE_KEY,
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
            organizationId: workingState.organization.organizationId,
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
