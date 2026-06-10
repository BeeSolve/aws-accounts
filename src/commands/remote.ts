import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import {
  BucketLocationConstraint,
  CreateBucketCommand,
  PutBucketTaggingCommand,
  S3Client,
  type S3ServiceException,
} from "@aws-sdk/client-s3";
import {
  CreateRoleCommand,
  GetRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
  TagRoleCommand,
} from "@aws-sdk/client-iam";
import {
  CreateFunctionCommand,
  GetFunctionCommand,
  LambdaClient,
  PutFunctionConcurrencyCommand,
  ResourceNotFoundException,
  TagResourceCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  PutRetentionPolicyCommand,
  DeleteRetentionPolicyCommand,
  ResourceAlreadyExistsException,
  TagLogGroupCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  CreatePermissionSetCommand,
  DescribePermissionSetCommand,
  ListPermissionSetsCommand,
  PutInlinePolicyToPermissionSetCommand,
  SSOAdminClient,
  TagResourceCommand as SsoTagResourceCommand,
  UpdatePermissionSetCommand,
} from "@aws-sdk/client-sso-admin";
import {
  type AwsConfigModel,
  type AwsContextFile,
  type Deployment,
  loadAwsConfigModelFromTsFile,
  mapAwsConfigToState,
  readAwsContextFromFile,
  readPackageVersion,
  regenerateTypesFromState,
  writeAwsConfigFromState,
} from "../awsConfig.js";
import { buildAwsClientConfig } from "../awsClientConfig.js";
import { getStandardTags } from "../tags.js";
import type { AwsTag } from "../tags.js";
import { diffStates } from "../diff.js";
import { invokeLambda } from "../lambdaClient.js";
import type { Logger } from "../logger.js";
import type { Operation, Plan, StackSetOperation } from "../operations.js";
import { isCacheFresh, readStateCache, writeStateCache } from "../remoteStateCache.js";
import { applyReservedOuDeletionGuard } from "../reservedOuDeletion.js";
import { validateState, type StateFile } from "../state.js";
import { assertUnreachable, delay, startProgressTimer } from "../helpers.js";
import { toPreconditionError } from "../error.js";
import {
  sts,
  organizations,
  sso,
  identitystore,
  s3,
  logs,
  account,
  iam,
  lambda,
} from "@beesolve/iam-policy-ts";

const remoteCommandSchema = v.object({
  subcommand: v.picklist(["bootstrap", "scan", "init", "plan", "apply", "upgrade", "drift"]),
  profile: v.optional(v.string()),
  region: v.optional(v.string()),
  flags: v.object({
    yes: v.boolean(),
    refresh: v.boolean(),
    allowDestructive: v.boolean(),
    ignoreUnsupported: v.boolean(),
    update: v.boolean(),
  }),
});

export type RemoteCommandInput = v.InferOutput<typeof remoteCommandSchema> & {
  logger: Logger;
  overwriteConfirmation: (props: { fileSummaries: string[] }) => Promise<boolean>;
  stsClient: STSClient;
  s3Client: S3Client;
  iamClient: IAMClient;
  lambdaClient: LambdaClient;
  ssoAdminClient: SSOAdminClient;
};

const contextFilePath = "aws.context.json";
const configFilePath = "aws.config.ts";
const generatedConfigFilePath = "aws.config.generated.ts";
const typesFilePath = "aws.config.types.ts";
const cachePath = ".remote-state-cache.json";
const lambdaRoleName = "beesolve-aws-accounts-lambda-role";
const lambdaFunctionName = "beesolve-aws-accounts";
const lambdaLogGroupName = `/aws/lambda/${lambdaFunctionName}`;

export async function runRemoteBootstrap(input: RemoteCommandInput): Promise<void> {
  const lambdaZip = await readLambdaZip();

  const callerIdentity = await input.stsClient.send(new GetCallerIdentityCommand({}));
  const accountId = callerIdentity.Account;
  if (accountId == null) {
    throw new Error("Could not determine AWS account ID from STS.");
  }

  const resolvedRegion =
    input.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const bucketName = `beesolve-aws-accounts-state-${accountId}-${resolvedRegion}`;

  input.logger.log(`Account: ${accountId}`);
  input.logger.log(`Region: ${resolvedRegion}`);
  input.logger.log(`Bucket: ${bucketName}`);

  try {
    await input.s3Client.send(
      new CreateBucketCommand({
        Bucket: bucketName,
        CreateBucketConfiguration:
          resolvedRegion !== "us-east-1"
            ? {
                LocationConstraint: resolvedRegion as BucketLocationConstraint,
              }
            : undefined,
      }),
    );
    input.logger.log(`Created S3 bucket: ${bucketName}`);
  } catch (error: unknown) {
    const s3Error = error as S3ServiceException;
    if (s3Error.name === "BucketAlreadyOwnedByYou" || s3Error.name === "BucketAlreadyExists") {
      input.logger.log(`S3 bucket already exists: ${bucketName}`);
    } else {
      throw error;
    }
  }

  await input.s3Client.send(
    new PutBucketTaggingCommand({
      Bucket: bucketName,
      Tagging: {
        TagSet: getStandardTags("state-storage"),
      },
    }),
  );

  const { roleArn } = await ensureIamRole({
    iamClient: input.iamClient,
    bucketName,
    logger: input.logger,
  });

  let context: AwsContextFile | null = null;
  try {
    context = await readAwsContextFromFile(contextFilePath);
  } catch {
    // File doesn't exist yet on fresh bootstrap — that's expected
  }

  const lambdaArn = await ensureLambdaFunction({
    lambdaClient: input.lambdaClient,
    roleArn,
    lambdaZip,
    bucketName,
    resolvedRegion,
    lambdaMemoryMb: context?.deployment?.lambdaMemoryMb,
    lambdaTimeoutSeconds: context?.deployment?.lambdaTimeoutSeconds,
    logger: input.logger,
  });

  // Persist deployment to context file
  const cliVersionForBootstrap = await readPackageVersion();
  const deployment: Deployment = {
    profile: input.profile ?? "",
    region: resolvedRegion,
    lambdaArn,
    stateBucketName: bucketName,
    stateCacheTtlSeconds: 300,
    lambdaMemoryMb: context?.deployment?.lambdaMemoryMb ?? 1024,
    lambdaTimeoutSeconds: context?.deployment?.lambdaTimeoutSeconds ?? 300,
    cliVersion: cliVersionForBootstrap,
  };

  const updatedContext =
    context != null
      ? { ...context, deployment }
      : {
          version: "1",
          generatedAt: new Date().toISOString(),
          organization: {
            id: "pending",
            managementAccountId: accountId,
            rootId: "pending",
            graveyardOuId: "pending",
          },
          identityCenter: { instanceArn: "pending", identityStoreId: "pending" },
          deployment,
        };

  const ordered: Record<string, unknown> = {
    version: updatedContext.version,
    generatedAt: updatedContext.generatedAt,
    organization: updatedContext.organization,
    identityCenter: updatedContext.identityCenter,
    deployment: updatedContext.deployment,
  };
  await writeFile(contextFilePath, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");

  await ensureLogGroup({
    region: resolvedRegion,
    profile: input.profile ?? "",
    retentionDays: deployment.logsRetentionDays,
    logger: input.logger,
  });

  const instanceArn = updatedContext.identityCenter?.instanceArn;

  if (instanceArn != null && instanceArn !== "" && instanceArn !== "pending") {
    await ensureOrganizationManagementPermissionSet({
      ssoAdminClient: input.ssoAdminClient,
      instanceArn,
      tags: getStandardTags("organization-management"),
      logger: input.logger,
    }).catch((error: unknown) => {
      input.logger.log(
        `Error creating OrganizationManagement permission set: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    await ensureOrganizationRemoteManagementPermissionSet({
      ssoAdminClient: input.ssoAdminClient,
      instanceArn,
      lambdaArn,
      tags: getStandardTags("remote-invocation"),
      logger: input.logger,
    }).catch((error: unknown) => {
      input.logger.log(
        `Error creating OrganizationRemoteManagement permission set: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  if (instanceArn == null || instanceArn === "") {
    input.logger.log("IAM Identity Center not configured, skipping permission set creation.");
  }

  input.logger.log("");
  input.logger.log("Bootstrap complete.");
  input.logger.log(`  Lambda ARN: ${lambdaArn}`);
  input.logger.log(`  State bucket: ${bucketName}`);
}

async function applyLambdaRolePolicy(props: {
  iamClient: IAMClient;
  bucketName: string;
}): Promise<void> {
  const inlinePolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: organizations("*"),
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: [sso("*"), identitystore("*")],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: [s3("GetObject"), s3("PutObject"), s3("ListBucket")],
        Resource: [`arn:aws:s3:::${props.bucketName}`, `arn:aws:s3:::${props.bucketName}/*`],
      },
      {
        Effect: "Allow",
        Action: [logs("CreateLogGroup"), logs("CreateLogStream"), logs("PutLogEvents")],
        Resource: "arn:aws:logs:*:*:*",
      },
      {
        Effect: "Allow",
        Action: [
          account("PutAccountName"),
          account("GetAlternateContact"),
          account("PutAlternateContact"),
          account("DeleteAlternateContact"),
        ],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: [
          "cloudformation:CreateStackSet",
          "cloudformation:UpdateStackSet",
          "cloudformation:DeleteStackSet",
          "cloudformation:DescribeStackSet",
          "cloudformation:DescribeStackSetOperation",
          "cloudformation:TagResource",
          "cloudformation:ListStackSets",
          "cloudformation:ListStackInstances",
          "cloudformation:CreateStackInstances",
          "cloudformation:UpdateStackInstances",
          "cloudformation:DeleteStackInstances",
        ],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Resource: "arn:aws:iam::*:role/BeesolveSecuritySetupRole",
      },
    ],
  });

  await props.iamClient.send(
    new PutRolePolicyCommand({
      RoleName: lambdaRoleName,
      PolicyName: "beesolve-aws-accounts-execution-policy",
      PolicyDocument: inlinePolicy,
    }),
  );
}

async function ensureIamRole(props: {
  iamClient: IAMClient;
  bucketName: string;
  logger: Logger;
}): Promise<{ roleArn: string }> {
  const trustPolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: sts("AssumeRole"),
      },
    ],
  });

  const { roleArn } = await getOrCreateIamRole({
    iamClient: props.iamClient,
    trustPolicy,
    logger: props.logger,
  });

  await applyLambdaRolePolicy({
    iamClient: props.iamClient,
    bucketName: props.bucketName,
  });

  return { roleArn };
}

async function getOrCreateIamRole(props: {
  iamClient: IAMClient;
  trustPolicy: string;
  logger: Logger;
}): Promise<{ roleArn: string }> {
  try {
    const getRole = await props.iamClient.send(new GetRoleCommand({ RoleName: lambdaRoleName }));
    const roleArn = getRole.Role?.Arn ?? "";
    if (roleArn === "") {
      throw new Error("IAM role exists but ARN is empty.");
    }
    props.logger.log(`IAM role already exists: ${lambdaRoleName}`);

    await props.iamClient.send(
      new TagRoleCommand({
        RoleName: lambdaRoleName,
        Tags: getStandardTags("execution-role"),
      }),
    );
    return { roleArn };
  } catch (error: unknown) {
    if ((error as any).name !== "NoSuchEntityException") {
      throw error;
    }
  }

  const createRole = await props.iamClient.send(
    new CreateRoleCommand({
      RoleName: lambdaRoleName,
      AssumeRolePolicyDocument: props.trustPolicy,
      Description: "Execution role for beesolve-aws-accounts Lambda",
      Tags: getStandardTags("execution-role"),
    }),
  );
  const roleArn = createRole.Role?.Arn ?? "";
  if (roleArn === "") {
    throw new Error("Failed to create IAM role: ARN is empty.");
  }
  props.logger.log(`Created IAM role: ${lambdaRoleName}`);
  return { roleArn };
}

async function ensureLambdaFunction(props: {
  lambdaClient: LambdaClient;
  roleArn: string;
  lambdaZip: Buffer;
  bucketName: string;
  resolvedRegion: string;
  lambdaMemoryMb?: number;
  lambdaTimeoutSeconds?: number;
  logger: Logger;
}): Promise<string> {
  try {
    // Check if function already exists
    const getFunction = await props.lambdaClient.send(
      new GetFunctionCommand({ FunctionName: lambdaFunctionName }),
    );
    const existingArn = getFunction.Configuration?.FunctionArn ?? "";
    if (existingArn === "") {
      throw new Error("Lambda function exists but ARN is empty.");
    }

    // Wait for any in-progress update to complete
    await waitForLambdaReady(props.lambdaClient, lambdaFunctionName);

    // Update function code
    await props.lambdaClient.send(
      new UpdateFunctionCodeCommand({
        FunctionName: lambdaFunctionName,
        ZipFile: props.lambdaZip,
      }),
    );

    // Wait for the code update to complete before updating configuration
    await waitForLambdaReady(props.lambdaClient, lambdaFunctionName);

    // Ensure environment variables and resource limits are set
    await props.lambdaClient.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: lambdaFunctionName,
        MemorySize: props.lambdaMemoryMb ?? 1024,
        Timeout: props.lambdaTimeoutSeconds ?? 300,
        Environment: {
          Variables: {
            STATE_BUCKET_NAME: props.bucketName,
          },
        },
      }),
    );

    // Apply standard tags to existing Lambda function
    await props.lambdaClient.send(
      new TagResourceCommand({
        Resource: existingArn,
        Tags: Object.fromEntries(getStandardTags("remote-execution").map((t) => [t.Key, t.Value])),
      }),
    );

    props.logger.log(`Updated Lambda function code: ${lambdaFunctionName}`);
    return existingArn;
  } catch (error: unknown) {
    if (error instanceof ResourceNotFoundException) {
      const lambdaArn = await createLambdaFunctionWithRetry({
        lambdaClient: props.lambdaClient,
        roleArn: props.roleArn,
        lambdaZip: props.lambdaZip,
        bucketName: props.bucketName,
        lambdaMemoryMb: props.lambdaMemoryMb,
        lambdaTimeoutSeconds: props.lambdaTimeoutSeconds,
        logger: props.logger,
      });

      await props.lambdaClient.send(
        new PutFunctionConcurrencyCommand({
          FunctionName: lambdaFunctionName,
          ReservedConcurrentExecutions: 1,
        }),
      );

      props.logger.log(`Created Lambda function: ${lambdaFunctionName}`);
      props.logger.log(`Set reserved concurrency to 1`);
      return lambdaArn;
    }
    throw error;
  }
}

const IAM_PROPAGATION_MAX_ATTEMPTS = 10;
const IAM_PROPAGATION_RETRY_INTERVAL_MS = 2_000;

async function createLambdaFunctionWithRetry(props: {
  lambdaClient: LambdaClient;
  roleArn: string;
  lambdaZip: Buffer;
  bucketName: string;
  lambdaMemoryMb?: number;
  lambdaTimeoutSeconds?: number;
  logger: Logger;
}): Promise<string> {
  for (let attempt = 1; attempt <= IAM_PROPAGATION_MAX_ATTEMPTS; attempt++) {
    try {
      const createResult = await props.lambdaClient.send(
        new CreateFunctionCommand({
          FunctionName: lambdaFunctionName,
          Runtime: "nodejs24.x",
          Handler: "handler.handler",
          Role: props.roleArn,
          Code: { ZipFile: props.lambdaZip },
          Timeout: props.lambdaTimeoutSeconds ?? 300,
          MemorySize: props.lambdaMemoryMb ?? 1024,
          PackageType: "Zip",
          Architectures: ["arm64"],
          Environment: {
            Variables: {
              STATE_BUCKET_NAME: props.bucketName,
            },
          },
          Tags: Object.fromEntries(
            getStandardTags("remote-execution").map((t) => [t.Key, t.Value]),
          ),
        }),
      );
      const lambdaArn = createResult.FunctionArn ?? "";
      if (lambdaArn === "") {
        throw new Error("Failed to create Lambda function: ARN is empty.");
      }
      return lambdaArn;
    } catch (error: unknown) {
      const isRoleNotReady = (error as any).name === "InvalidParameterValueException";
      if (!isRoleNotReady || attempt === IAM_PROPAGATION_MAX_ATTEMPTS) {
        throw error;
      }
      props.logger.log(
        `Waiting for IAM role to propagate (attempt ${attempt}/${IAM_PROPAGATION_MAX_ATTEMPTS})...`,
      );
      await delay(IAM_PROPAGATION_RETRY_INTERVAL_MS);
    }
  }
  throw new Error("Unreachable: retry loop exhausted without throwing.");
}

export async function runRemoteScan(input: RemoteCommandInput): Promise<void> {
  const deployment = await readDeploymentFromContext();

  const clientConfig = buildAwsClientConfig({
    profile: input.profile ?? (deployment.profile || undefined),
    region: input.region ?? (deployment.region || undefined),
  });
  const lambdaClient = new LambdaClient(clientConfig);

  input.logger.log("Invoking remote scan...");
  const stopScanProgress = startProgressTimer((elapsed) => {
    input.logger.log(`Still scanning... (${elapsed}s)`);
  });
  const result = await invokeLambda({
    lambdaClient,
    lambdaArn: deployment.lambdaArn,
    payload: { action: "scan" },
  });
  stopScanProgress();

  if (!result.ok) {
    throw new Error(formatLambdaError(result.error));
  }

  const response = result.response;
  if (!("action" in response) || response.action !== "scan") {
    throw new Error("Unexpected response from Lambda scan action.");
  }

  input.logger.log("Scan complete.");
  input.logger.log(`  Organizational Units: ${response.summary.organizationalUnits}`);
  input.logger.log(`  Accounts: ${response.summary.accounts}`);
  input.logger.log(`  Users: ${response.summary.users}`);
  input.logger.log(`  Groups: ${response.summary.groups}`);
  input.logger.log(`  Permission Sets: ${response.summary.permissionSets}`);
  input.logger.log(`  Account Assignments: ${response.summary.accountAssignments}`);
  input.logger.log(`  Policies: ${response.summary.policies}`);
  input.logger.log(`  Policy Attachments: ${response.summary.policyAttachments}`);

  await writeStateCache(cachePath, response.state);
  input.logger.log("State cache updated.");
}

export async function runRemoteInit(input: RemoteCommandInput): Promise<void> {
  const isUpdate = input.flags.update;

  // In --update mode, load existing config before scan so we can merge additively
  let existingConfig: Awaited<ReturnType<typeof loadAwsConfigModelFromTsFile>> | undefined;
  if (isUpdate) {
    try {
      existingConfig = await loadAwsConfigModelFromTsFile({
        configPath: generatedConfigFilePath,
        typesPath: typesFilePath,
      });
    } catch {
      // Config doesn't exist yet — fall through to full init behaviour
    }
  }

  const [deployment, cliVersion] = await Promise.all([
    readDeploymentFromContext(),
    readPackageVersion(),
  ]);

  input.logger.log("Invoking remote scan...");
  const stopInitScanProgress = startProgressTimer((elapsed) => {
    input.logger.log(`Still scanning... (${elapsed}s)`);
  });
  const result = await invokeLambda({
    lambdaClient: input.lambdaClient,
    lambdaArn: deployment.lambdaArn,
    payload: { action: "scan" },
  });
  stopInitScanProgress();

  if (!result.ok) {
    throw new Error(formatLambdaError(result.error));
  }

  const response = result.response;
  if (!("action" in response) || response.action !== "scan") {
    throw new Error("Unexpected response from Lambda scan action.");
  }

  input.logger.log("Scan complete.");
  input.logger.log(`  Organizational Units: ${response.summary.organizationalUnits}`);
  input.logger.log(`  Accounts: ${response.summary.accounts}`);
  input.logger.log(`  Users: ${response.summary.users}`);
  input.logger.log(`  Groups: ${response.summary.groups}`);
  input.logger.log(`  Permission Sets: ${response.summary.permissionSets}`);
  input.logger.log(`  Account Assignments: ${response.summary.accountAssignments}`);
  input.logger.log(`  Policies: ${response.summary.policies}`);
  input.logger.log(`  Policy Attachments: ${response.summary.policyAttachments}`);

  await writeStateCache(cachePath, response.state);
  input.logger.log("State cache updated.");

  // Update context file with real values from scan (replaces bootstrap placeholders)
  const context = await readAwsContextFromFile(contextFilePath);
  const graveyardOu = response.state.organization.organizationalUnits.find(
    (ou: { name: string }) => ou.name === "Graveyard",
  );
  const ordered: Record<string, unknown> = {
    version: context.version,
    generatedAt: new Date().toISOString(),
    organization: {
      id: response.state.organization.organizationId,
      managementAccountId: context.organization.managementAccountId,
      rootId: response.state.organization.rootId,
      graveyardOuId: graveyardOu?.id ?? context.organization.graveyardOuId,
    },
    identityCenter: {
      instanceArn: response.state.identityCenter.instanceArn,
      identityStoreId: response.state.identityCenter.identityStoreId,
    },
    deployment: { ...deployment, cliVersion },
  };
  await writeFile(contextFilePath, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");

  const configWriteResult = await writeAwsConfigFromState({
    state: response.state,
    contextPath: contextFilePath,
    configPath: generatedConfigFilePath,
    typesPath: typesFilePath,
    logger: input.logger,
    overwriteConfirmation: input.overwriteConfirmation,
    existingConfig,
  });

  if (!existsSync(configFilePath)) {
    await writeFile(
      configFilePath,
      `import config from "./aws.config.generated.js";

export default config;
`,
      "utf8",
    );
    input.logger.log(`Created ${configFilePath} (edit this file to add withSecurityBaseline or other wrappers).`);
  }

  const writtenFiles = configWriteResult.files.filter((f) => f.status === "written");
  if (writtenFiles.length > 0) {
    input.logger.log("");
    input.logger.log(isUpdate ? "Init --update complete." : "Init complete.");
    for (const file of writtenFiles) {
      input.logger.log(`  ${file.path}: ${file.status}`);
    }
  }
}

export async function runRemotePlan(input: RemoteCommandInput): Promise<void> {
  const deployment = await readDeploymentFromContext();
  const currentState = await fetchCurrentState({
    input,
    deployment,
  });

  await checkPendingStackSetOperations({
    state: currentState,
    lambdaClient: input.lambdaClient,
    lambdaArn: deployment.lambdaArn,
    logger: input.logger,
  });

  const [context, config] = await Promise.all([
    readAwsContextFromFile(contextFilePath),
    loadAwsConfigModelFromTsFile({
      configPath: configFilePath,
      typesPath: typesFilePath,
    }),
  ]);

  warnIfRemotePoliciesNotInConfig({ currentState, config, logger: input.logger });

  const desiredState = mapAwsConfigToState({
    config,
    currentState,
    context,
  });

  const plan = applyReservedOuDeletionGuard({
    plan: diffStates({
      current: currentState,
      next: desiredState,
    }),
    context,
  });

  const ouIdsByName = Object.fromEntries(
    currentState.organization.organizationalUnits.map((ou) => [ou.name, ou.id]),
  );
  ouIdsByName["root"] = context.organization.rootId;
  const stackSetOperations = computeStackSetOperations(config, {
    managementAccountId: context.organization.managementAccountId,
    organizationId: context.organization.id,
    region: deployment.region,
    ouIdsByName,
    deployedStackSets: currentState.deployedStackSets,
  });

  if (plan.operations.length === 0 && (stackSetOperations?.length ?? 0) === 0) {
    input.logger.log("No changes: aws.config.ts already matches the current remote state.");
    return;
  }

  displayPlan({ plan, stackSetOperations, logger: input.logger });
}

export async function runRemoteApply(input: RemoteCommandInput): Promise<void> {
  const deployment = await readDeploymentFromContext();
  const currentState = await fetchCurrentState({
    input,
    deployment,
  });

  await checkPendingStackSetOperations({
    state: currentState,
    lambdaClient: input.lambdaClient,
    lambdaArn: deployment.lambdaArn,
    logger: input.logger,
  });

  const [context, config] = await Promise.all([
    readAwsContextFromFile(contextFilePath),
    loadAwsConfigModelFromTsFile({
      configPath: configFilePath,
      typesPath: typesFilePath,
    }),
  ]);

  warnIfRemotePoliciesNotInConfig({ currentState, config, logger: input.logger });

  const desiredState = mapAwsConfigToState({
    config,
    currentState,
    context,
  });

  const plan = applyReservedOuDeletionGuard({
    plan: diffStates({
      current: currentState,
      next: desiredState,
    }),
    context,
  });

  const ouIdsByName = Object.fromEntries(
    currentState.organization.organizationalUnits.map((ou) => [ou.name, ou.id]),
  );
  ouIdsByName["root"] = context.organization.rootId;
  const stackSetOperations = computeStackSetOperations(config, {
    managementAccountId: context.organization.managementAccountId,
    organizationId: context.organization.id,
    region: deployment.region,
    ouIdsByName,
    deployedStackSets: currentState.deployedStackSets,
  });

  if (plan.operations.length === 0 && (stackSetOperations?.length ?? 0) === 0) {
    input.logger.log("No changes: aws.config.ts already matches the current remote state.");
    input.logger.log(
      "If you expected changes, verify your config with aws-accounts validate or run with --refresh to fetch fresh state.",
    );
    return;
  }

  displayPlan({ plan, stackSetOperations, logger: input.logger });

  if (plan.operations.some(isDestructiveOperation) && !input.flags.allowDestructive) {
    throw new Error("Destructive operations detected. Pass --allow-destructive to proceed.");
  }

  if (!input.flags.yes) {
    if (process.stdin.isTTY !== true) {
      throw new Error("Refusing to apply changes in non-interactive mode without --yes.");
    }
    const readlineInterface = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await readlineInterface.question(
        "Proceed with applying these changes? [y/N] ",
      );
      const normalized = answer.trim().toLowerCase();
      if (normalized !== "y" && normalized !== "yes") {
        input.logger.log("Apply cancelled.");
        return;
      }
    } finally {
      readlineInterface.close();
    }
  }

  const clientConfig = buildAwsClientConfig({
    profile: input.profile ?? (deployment.profile || undefined),
    region: input.region ?? (deployment.region || undefined),
  });
  const lambdaClient = new LambdaClient(clientConfig);

  if (plan.operations.length > 0) {
    input.logger.log("Applying changes remotely...");
    const stopProgress = startProgressTimer((elapsed) => {
      input.logger.log(`Still applying... (${elapsed}s)`);
    });
    const result = await invokeLambda({
      lambdaClient,
      lambdaArn: deployment.lambdaArn,
      payload: {
        action: "apply",
        operations: plan.operations,
        allowDestructive: input.flags.allowDestructive,
      },
    });
    stopProgress();

    if (!result.ok) {
      const error = result.error;
      if (error.kind === "concurrencyConflict") {
        input.logger.log("Another apply is in progress. Retry later.");
        return;
      }
      if (error.kind === "operationFailed") {
        input.logger.log(
          `Apply failed at operation ${error.failedOperation + 1} of ${error.totalOperations}: ${error.error}`,
        );
        await writeStateCache(cachePath, error.partialState);
        input.logger.log("State cache updated with partial state.");
        input.logger.log("Run aws-accounts scan --refresh to refresh state before retrying.");
        return;
      }
      throw new Error(formatLambdaError(error));
    }

    const response = result.response;
    if (!("action" in response) || response.action !== "apply") {
      throw new Error("Unexpected response from Lambda apply action.");
    }

    input.logger.log(`Applied ${response.operationsCompleted} operation(s).`);
    await writeStateCache(cachePath, response.state);

    await regenerateTypesFromState({
      state: response.state,
      contextPath: contextFilePath,
      configPath: configFilePath,
      typesPath: typesFilePath,
      logger: input.logger,
    });
  }

  if (stackSetOperations != null && stackSetOperations.length > 0) {
    const securitySetupOps = stackSetOperations.filter((op) => op.stackSetName === "security-setup");
    const remainingOps = stackSetOperations.filter((op) => op.stackSetName !== "security-setup");

    let allPendingOps: Array<{ stackSetName: string; operationId: string; startedAt: string }> = [];

    if (securitySetupOps.length > 0) {
      const pending = await executeStackSetOperations({
        stackSetOperations: securitySetupOps,
        lambdaClient,
        lambdaArn: deployment.lambdaArn,
        logger: input.logger,
      });
      allPendingOps = allPendingOps.concat(pending);
    }

    const deliveryBucket = config.securityBaseline?.configDeliveryBucket;
    if (deliveryBucket) {
      const deliveryBucketName = `config-delivery-${context.organization.id!}-${deployment.region}`;
      const deliveryAccountId = currentState.organization.accounts.find(
        (a) => a.name === deliveryBucket.accountName,
      )?.id;
      if (deliveryAccountId) {
        input.logger.log(`  [bucket] creating Config delivery bucket "${deliveryBucketName}" in account ${deliveryAccountId}...`);
        const bucketResult = await invokeLambda({
          lambdaClient,
          lambdaArn: deployment.lambdaArn,
          payload: {
            action: "createConfigDeliveryBucket" as const,
            targetAccountId: deliveryAccountId,
            bucketName: deliveryBucketName,
            region: deployment.region,
          },
        });
        if (!bucketResult.ok) {
          throw new Error(`Failed to create Config delivery bucket: ${formatLambdaError(bucketResult.error)}`);
        }
        input.logger.log(`  [bucket] Config delivery bucket ready.`);
      }
    }

    // Create Config aggregator in the delegated admin account
    const configDelegatedAdmin = config.delegatedAdministrators?.find(
      (d) => d.servicePrincipal === "config.amazonaws.com",
    );
    if (configDelegatedAdmin) {
      const adminAccountId = currentState.organization.accounts.find(
        (a) => a.name === configDelegatedAdmin.account,
      )?.id;
      if (adminAccountId) {
        input.logger.log(`  [aggregator] creating Config aggregator in account ${adminAccountId}...`);
        const aggResult = await invokeLambda({
          lambdaClient,
          lambdaArn: deployment.lambdaArn,
          payload: {
            action: "createConfigAggregator" as const,
            targetAccountId: adminAccountId,
            region: deployment.region,
          },
        });
        if (!aggResult.ok) {
          input.logger.log(`  [aggregator] warning: ${formatLambdaError(aggResult.error)}`);
        } else {
          input.logger.log(`  [aggregator] Config aggregator ready.`);
        }
      }
    }

    if (remainingOps.length > 0) {
      const pending = await executeStackSetOperations({
        stackSetOperations: remainingOps,
        lambdaClient,
        lambdaArn: deployment.lambdaArn,
        logger: input.logger,
      });
      allPendingOps = allPendingOps.concat(pending);
    }

    // Record deployed StackSets in state for idempotency
    const allDeployed = stackSetOperations.map((op) => ({
      name: op.stackSetName,
      targets: op.targets,
    }));
    await invokeLambda({
      lambdaClient,
      lambdaArn: deployment.lambdaArn,
      payload: {
        action: "recordDeployedStackSets" as const,
        stackSets: allDeployed,
        pendingOperations: allPendingOps,
      },
    });

    // Update local cache so next plan sees the deployed stacksets
    const updatedState = { ...currentState, deployedStackSets: allDeployed, pendingStackSetOperations: allPendingOps.length > 0 ? allPendingOps : undefined };
    await writeStateCache(cachePath, updatedState);
  }
}

export async function runRemoteUpgrade(input: RemoteCommandInput): Promise<void> {
  const [deployment, cliVersion, lambdaZip] = await Promise.all([
    readDeploymentFromContext(),
    readPackageVersion(),
    readLambdaZip(),
  ]);

  input.logger.log(`Updating Lambda function code: ${deployment.lambdaArn}`);
  await waitForLambdaReady(input.lambdaClient, deployment.lambdaArn);
  const updateResult = await input.lambdaClient.send(
    new UpdateFunctionCodeCommand({
      FunctionName: deployment.lambdaArn,
      ZipFile: lambdaZip,
    }),
  );

  const lastModified = updateResult.LastModified ?? "unknown";
  input.logger.log(`Lambda updated. Last modified: ${lastModified}`);

  await waitForLambdaReady(input.lambdaClient, deployment.lambdaArn);
  await input.lambdaClient.send(
    new UpdateFunctionConfigurationCommand({
      FunctionName: deployment.lambdaArn,
      MemorySize: deployment.lambdaMemoryMb ?? 1024,
      Timeout: deployment.lambdaTimeoutSeconds ?? 300,
    }),
  );

  input.logger.log("Updating IAM role policy...");
  await applyLambdaRolePolicy({
    iamClient: input.iamClient,
    bucketName: deployment.stateBucketName,
  });
  input.logger.log("IAM role policy updated.");

  await ensureLogGroup({
    region: deployment.region,
    profile: deployment.profile,
    retentionDays: deployment.logsRetentionDays,
    logger: input.logger,
  });

  const context = await readAwsContextFromFile(contextFilePath);
  const ordered: Record<string, unknown> = {
    version: context.version,
    generatedAt: context.generatedAt,
    organization: context.organization,
    identityCenter: context.identityCenter,
    deployment: { ...deployment, cliVersion },
  };
  await writeFile(contextFilePath, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");

  input.logger.log("");
  input.logger.log(
    "Run init --update to sync your config with new remote features before using plan/apply.",
  );
}

export async function runRemoteDrift(input: RemoteCommandInput): Promise<void> {
  const deployment = await readDeploymentFromContext();

  const baseline = await fetchCurrentState({
    input,
    deployment,
  });

  const clientConfig = buildAwsClientConfig({
    profile: input.profile ?? (deployment.profile || undefined),
    region: input.region ?? (deployment.region || undefined),
  });
  const lambdaClient = new LambdaClient(clientConfig);

  input.logger.log("Scanning live AWS state...");
  const stopDriftProgress = startProgressTimer((elapsed) => {
    input.logger.log(`Still scanning... (${elapsed}s)`);
  });
  const result = await invokeLambda({
    lambdaClient,
    lambdaArn: deployment.lambdaArn,
    payload: { action: "scan" },
  });
  stopDriftProgress();

  if (!result.ok) {
    throw new Error(formatLambdaError(result.error));
  }

  const response = result.response;
  if (!("action" in response) || response.action !== "scan") {
    throw new Error("Unexpected response from Lambda scan action.");
  }

  const liveState = response.state;
  await writeStateCache(cachePath, liveState);

  const plan = diffStates({
    current: baseline,
    next: liveState,
  });

  displayDrift({ plan, logger: input.logger });
}

function displayDrift(props: { plan: Plan; logger: Logger }): void {
  const driftOperations = props.plan.operations.filter(
    (operation) => operation.kind !== "provisionIdcPermissionSet",
  );

  if (driftOperations.length === 0 && props.plan.unsupported.length === 0) {
    props.logger.log("No drift.");
    return;
  }

  props.logger.log(`Drift: ${driftOperations.length} change(s) detected since last scan`);
  for (const operation of driftOperations) {
    props.logger.log(formatOperationLine(operation));
  }

  if (props.plan.unsupported.length > 0) {
    props.logger.log("Unsupported diffs:");
    for (const diff of props.plan.unsupported) {
      props.logger.log(`  - ${diff.description} [${diff.category}]`);
    }
  }
}

function warnIfRemotePoliciesNotInConfig(props: {
  currentState: StateFile;
  config: AwsConfigModel;
  logger: Logger;
}): void {
  const remotePolicies = props.currentState.organization.policies ?? [];
  const hasRemotePolicies = remotePolicies.length > 0;
  const hasLocalPolicies =
    props.config.policies.serviceControlPolicies.length > 0 ||
    props.config.policies.resourceControlPolicies.length > 0;
  if (hasRemotePolicies && !hasLocalPolicies) {
    props.logger.log("");
    props.logger.log(
      "Warning: remote state contains SCPs/RCPs not present in your config. Proceeding could delete them.",
    );
    props.logger.log("Run init --update to sync first.");
    props.logger.log("");
  }
}

async function readDeploymentFromContext(): Promise<Deployment> {
  let context: AwsContextFile;
  try {
    context = await readAwsContextFromFile(contextFilePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw toPreconditionError("aws.context.json not found. Run `aws-accounts bootstrap` first.");
    }
    throw err;
  }
  if (context.deployment == null) {
    throw toPreconditionError(
      "No deployment found in aws.context.json. Run `aws-accounts bootstrap` first.",
    );
  }
  return context.deployment;
}

async function fetchCurrentState(props: {
  input: RemoteCommandInput;
  deployment: Deployment;
}): Promise<StateFile> {
  if (!props.input.flags.refresh) {
    const cache = await readStateCache(cachePath);
    if (cache != null && isCacheFresh(cache, props.deployment.stateCacheTtlSeconds)) {
      const elapsedMinutes = Math.round((Date.now() - new Date(cache.fetchedAt).getTime()) / 60000);
      props.input.logger.log(
        `Using cached state (fetched ${elapsedMinutes} minute(s) ago). Use --refresh to force a fresh fetch.`,
      );
      return cache.state;
    }
  }

  props.input.logger.log("Fetching remote state...");
  const clientConfig = buildAwsClientConfig({
    profile: props.input.profile ?? (props.deployment.profile || undefined),
    region: props.input.region ?? (props.deployment.region || undefined),
  });
  const lambdaClient = new LambdaClient(clientConfig);

  const stopFetchProgress = startProgressTimer((elapsed) => {
    props.input.logger.log(`Still fetching... (${elapsed}s)`);
  });

  const result = await invokeLambda({
    lambdaClient,
    lambdaArn: props.deployment.lambdaArn,
    payload: { action: "getStateUrl" },
  });

  if (!result.ok) {
    stopFetchProgress();
    throw new Error(formatLambdaError(result.error));
  }

  const response = result.response;
  if (!("action" in response) || response.action !== "getStateUrl") {
    stopFetchProgress();
    throw new Error("Unexpected response from Lambda getStateUrl action.");
  }

  const stateResponse = await fetch(response.url);
  stopFetchProgress();

  if (!stateResponse.ok) {
    throw new Error(
      `Failed to fetch state from pre-signed URL: ${stateResponse.status} ${stateResponse.statusText}`,
    );
  }

  const stateJson = await stateResponse.json();
  const state = validateState(stateJson);

  await writeStateCache(cachePath, state);
  props.input.logger.log("State cache updated.");

  return state;
}

function displayPlan(props: {
  plan: Plan;
  stackSetOperations?: StackSetOperation[];
  logger: Logger;
}): void {
  const stackSetCount = props.stackSetOperations?.length ?? 0;
  props.logger.log(
    `Plan: ${props.plan.operations.length} operation(s)${stackSetCount > 0 ? `, ${stackSetCount} stackset operation(s)` : ""}, ${props.plan.unsupported.length} unsupported diff(s)`,
  );

  const destructiveOperations = props.plan.operations.filter((op) => isDestructiveOperation(op));
  if (destructiveOperations.length > 0) {
    props.logger.log(
      `Destructive operations detected: ${destructiveOperations.length}. Apply requires --allow-destructive.`,
    );
  }

  for (const operation of props.plan.operations) {
    props.logger.log(formatOperationLine(operation));
  }

  if (props.stackSetOperations != null) {
    for (const op of props.stackSetOperations) {
      props.logger.log(
        `  [stackset] ${op.action} "${op.stackSetName}" targeting ${op.targets.join(", ")}`,
      );
    }
  }

  if (props.plan.unsupported.length > 0) {
    props.logger.log("Unsupported diffs:");
    for (const diff of props.plan.unsupported) {
      props.logger.log(`  - ${diff.description} [${diff.category}]`);
    }
    props.logger.log(
      "These changes require manual action in the AWS Console and will not be applied automatically.",
    );
  }
}

function isDestructiveOperation(operation: Operation): boolean {
  return (
    operation.kind === "deleteOu" ||
    operation.kind === "removeAccount" ||
    operation.kind === "deleteIdcUser" ||
    operation.kind === "deleteIdcGroup" ||
    operation.kind === "deleteIdcPermissionSet" ||
    operation.kind === "deleteIdcPermissionSetPermissionsBoundary" ||
    operation.kind === "detachOrgPolicy" ||
    operation.kind === "deleteOrgPolicy" ||
    operation.kind === "deregisterDelegatedAdministrator"
  );
}

function formatOperationLine(operation: Operation): string {
  if (operation.kind === "moveAccount") {
    return `  move account "${operation.accountName}" (${operation.accountId}) from ${operation.fromOuName} -> ${operation.toOuName}`;
  }
  if (operation.kind === "createOu") {
    return `  create OU "${operation.ouName}" under ${operation.parentOuName}`;
  }
  if (operation.kind === "renameOu") {
    return `  rename OU "${operation.fromOuName}" -> "${operation.toOuName}"`;
  }
  if (operation.kind === "deleteOu") {
    return `  [destructive] delete OU "${operation.ouName}" from ${operation.parentOuName}`;
  }
  if (operation.kind === "createAccount") {
    return `  create account "${operation.accountName}" (${operation.accountEmail}) in ${operation.targetOuName}`;
  }
  if (operation.kind === "updateAccountTags") {
    return `  update account tags "${operation.accountName}" (${operation.accountId})`;
  }
  if (operation.kind === "updateAccountName") {
    return `  rename account (${operation.accountId}): "${operation.fromAccountName}" -> "${operation.toAccountName}"`;
  }
  if (operation.kind === "removeAccount") {
    return `  [destructive] move removed account "${operation.accountName}" (${operation.accountId}) from ${operation.fromOuName} -> ${operation.toOuName}`;
  }
  if (operation.kind === "createIdcUser") {
    return `  create IdC user "${operation.userName}"`;
  }
  if (operation.kind === "updateIdcUser") {
    return `  update IdC user "${operation.userName}"`;
  }
  if (operation.kind === "deleteIdcUser") {
    return `  [destructive] delete IdC user "${operation.userName}"`;
  }
  if (operation.kind === "createIdcGroup") {
    return `  create IdC group "${operation.groupDisplayName}"`;
  }
  if (operation.kind === "updateIdcGroupDescription") {
    return `  update IdC group description for "${operation.groupDisplayName}"`;
  }
  if (operation.kind === "deleteIdcGroup") {
    return `  [destructive] delete IdC group "${operation.groupDisplayName}"`;
  }
  if (operation.kind === "addIdcGroupMembership") {
    return `  add user "${operation.userName}" to IdC group "${operation.groupDisplayName}"`;
  }
  if (operation.kind === "createIdcPermissionSet") {
    return `  create IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "updateIdcPermissionSetDescription") {
    return `  update IdC permission set description for "${operation.permissionSetName}"`;
  }
  if (operation.kind === "deleteIdcPermissionSet") {
    return `  [destructive] delete IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "putIdcPermissionSetInlinePolicy") {
    return `  put inline policy on IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "deleteIdcPermissionSetInlinePolicy") {
    return `  delete inline policy from IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "attachIdcManagedPolicyToPermissionSet") {
    return `  attach managed policy "${operation.managedPolicyArn}" to IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "detachIdcManagedPolicyFromPermissionSet") {
    return `  detach managed policy "${operation.managedPolicyArn}" from IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "attachIdcCustomerManagedPolicyReferenceToPermissionSet") {
    return `  attach customer-managed policy "${operation.customerManagedPolicyPath}${operation.customerManagedPolicyName}" to IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "detachIdcCustomerManagedPolicyReferenceFromPermissionSet") {
    return `  detach customer-managed policy "${operation.customerManagedPolicyPath}${operation.customerManagedPolicyName}" from IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "provisionIdcPermissionSet") {
    return `  provision IdC permission set "${operation.permissionSetName}" to all provisioned accounts`;
  }
  if (operation.kind === "putIdcPermissionSetPermissionsBoundary") {
    const b = operation.permissionsBoundary;
    const label =
      "managedPolicyArn" in b
        ? b.managedPolicyArn
        : `${b.customerManagedPolicyPath}${b.customerManagedPolicyName}`;
    return `  put permissions boundary "${label}" on IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "deleteIdcPermissionSetPermissionsBoundary") {
    return `  [destructive] delete permissions boundary from IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "removeIdcGroupMembership") {
    return `  remove user "${operation.userName}" from IdC group "${operation.groupDisplayName}"`;
  }
  if (operation.kind === "grantIdcAccountAssignment") {
    return `  grant IdC assignment "${operation.permissionSetName}" to ${formatPrincipalLabel(operation.principalType, operation.principalName)} on "${operation.accountName}"`;
  }
  if (operation.kind === "revokeIdcAccountAssignment") {
    return `  revoke IdC assignment "${operation.permissionSetName}" from ${formatPrincipalLabel(operation.principalType, operation.principalName)} on "${operation.accountName}"`;
  }
  if (operation.kind === "updateIdcPermissionSetSessionDuration") {
    const duration = operation.sessionDuration ?? "default";
    return `  update IdC permission set session duration "${operation.permissionSetName}" -> ${duration}`;
  }
  if (operation.kind === "createOrgPolicy") {
    return `  create org policy "${operation.policyName}" (${operation.policyType})`;
  }
  if (operation.kind === "updateOrgPolicyContent") {
    return `  update org policy content "${operation.policyName}"`;
  }
  if (operation.kind === "updateOrgPolicyDescription") {
    return `  update org policy description "${operation.policyName}"`;
  }
  if (operation.kind === "attachOrgPolicy") {
    return `  attach org policy "${operation.policyName}" to "${operation.targetName}"`;
  }
  if (operation.kind === "detachOrgPolicy") {
    return `  [destructive] detach org policy "${operation.policyName}" from "${operation.targetName}"`;
  }
  if (operation.kind === "deleteOrgPolicy") {
    return `  [destructive] delete org policy "${operation.policyName}"`;
  }
  if (operation.kind === "putAlternateContact") {
    return `  set ${operation.contactType} alternate contact for "${operation.accountName}" (${operation.accountId})`;
  }
  if (operation.kind === "deleteAlternateContact") {
    return `  [destructive] delete ${operation.contactType} alternate contact for "${operation.accountName}" (${operation.accountId})`;
  }
  if (operation.kind === "setIdcAccessControlAttributes") {
    return `  set IdC access control attributes (${operation.attributes.length} attribute(s))`;
  }
  if (operation.kind === "registerDelegatedAdministrator") {
    return `  register delegated administrator "${operation.accountName}" (${operation.accountId}) for ${operation.servicePrincipal}`;
  }
  if (operation.kind === "deregisterDelegatedAdministrator") {
    return `  [destructive] deregister delegated administrator "${operation.accountName}" (${operation.accountId}) for ${operation.servicePrincipal}`;
  }
  assertUnreachable(operation, "Unsupported operation kind in formatOperationLine.");
}

function formatPrincipalLabel(principalType: "GROUP" | "USER", principalName: string): string {
  if (principalType === "GROUP") {
    return `group "${principalName}"`;
  }
  return `user "${principalName}"`;
}

function formatLambdaError(error: { kind: string; [key: string]: unknown }): string {
  if (error.kind === "validation") {
    return `Lambda validation error: ${error.details}`;
  }
  if (error.kind === "concurrencyConflict") {
    return `Lambda concurrency conflict: ${error.message}`;
  }
  if (error.kind === "operationFailed") {
    return `Lambda operation failed: ${error.error}`;
  }
  if (error.kind === "invocationError") {
    return `Lambda invocation error: ${error.message}`;
  }
  return `Lambda error: ${JSON.stringify(error)}`;
}

async function findPermissionSetByName(props: {
  ssoAdminClient: SSOAdminClient;
  instanceArn: string;
  name: string;
}): Promise<string | undefined> {
  let nextToken: string | undefined;
  do {
    const listResponse = await props.ssoAdminClient.send(
      new ListPermissionSetsCommand({
        InstanceArn: props.instanceArn,
        NextToken: nextToken,
      }),
    );
    const permissionSetArns = listResponse.PermissionSets ?? [];
    for (const arn of permissionSetArns) {
      const describeResponse = await props.ssoAdminClient.send(
        new DescribePermissionSetCommand({
          InstanceArn: props.instanceArn,
          PermissionSetArn: arn,
        }),
      );
      if (describeResponse.PermissionSet?.Name === props.name) {
        return arn;
      }
    }
    nextToken = listResponse.NextToken;
  } while (nextToken != null);
  return undefined;
}

async function ensureOrganizationManagementPermissionSet(props: {
  ssoAdminClient: SSOAdminClient;
  instanceArn: string;
  tags: AwsTag[];
  logger: Logger;
}): Promise<{ permissionSetArn: string }> {
  const permissionSetName = "OrganizationManagement";
  const description =
    "Full organization management access for AWS Organizations, IAM Identity Center, and IAM";
  const sessionDuration = "PT4H";

  const inlinePolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [organizations("*"), sso("*"), identitystore("*"), account("*"), iam("*")],
        Resource: "*",
      },
    ],
  });

  const existingArn = await findPermissionSetByName({
    ssoAdminClient: props.ssoAdminClient,
    instanceArn: props.instanceArn,
    name: permissionSetName,
  });

  const permissionSetArn =
    existingArn != null
      ? await updateExistingPermissionSet({
          ssoAdminClient: props.ssoAdminClient,
          instanceArn: props.instanceArn,
          permissionSetArn: existingArn,
          permissionSetName,
          description,
          sessionDuration,
          logger: props.logger,
        })
      : await createNewPermissionSet({
          ssoAdminClient: props.ssoAdminClient,
          instanceArn: props.instanceArn,
          permissionSetName,
          description,
          sessionDuration,
          tags: props.tags,
          logger: props.logger,
        });

  await props.ssoAdminClient.send(
    new PutInlinePolicyToPermissionSetCommand({
      InstanceArn: props.instanceArn,
      PermissionSetArn: permissionSetArn,
      InlinePolicy: inlinePolicy,
    }),
  );

  // Apply tags (for both create and update to ensure idempotency)
  await props.ssoAdminClient.send(
    new SsoTagResourceCommand({
      InstanceArn: props.instanceArn,
      ResourceArn: permissionSetArn,
      Tags: props.tags.map((t) => ({ Key: t.Key, Value: t.Value })),
    }),
  );

  return { permissionSetArn };
}

async function ensureOrganizationRemoteManagementPermissionSet(props: {
  ssoAdminClient: SSOAdminClient;
  instanceArn: string;
  lambdaArn: string;
  tags: AwsTag[];
  logger: Logger;
}): Promise<{ permissionSetArn: string }> {
  const permissionSetName = "OrganizationRemoteManagement";
  const description = "Minimal access to invoke the beesolve-aws-accounts remote management Lambda";
  const sessionDuration = "PT1H";

  const inlinePolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [lambda("InvokeFunction")],
        Resource: props.lambdaArn,
      },
    ],
  });

  const existingArn = await findPermissionSetByName({
    ssoAdminClient: props.ssoAdminClient,
    instanceArn: props.instanceArn,
    name: permissionSetName,
  });

  const permissionSetArn =
    existingArn != null
      ? await updateExistingPermissionSet({
          ssoAdminClient: props.ssoAdminClient,
          instanceArn: props.instanceArn,
          permissionSetArn: existingArn,
          permissionSetName,
          description,
          sessionDuration,
          logger: props.logger,
        })
      : await createNewPermissionSet({
          ssoAdminClient: props.ssoAdminClient,
          instanceArn: props.instanceArn,
          permissionSetName,
          description,
          sessionDuration,
          tags: props.tags,
          logger: props.logger,
        });

  await props.ssoAdminClient.send(
    new PutInlinePolicyToPermissionSetCommand({
      InstanceArn: props.instanceArn,
      PermissionSetArn: permissionSetArn,
      InlinePolicy: inlinePolicy,
    }),
  );

  // Apply tags (for both create and update to ensure idempotency)
  await props.ssoAdminClient.send(
    new SsoTagResourceCommand({
      InstanceArn: props.instanceArn,
      ResourceArn: permissionSetArn,
      Tags: props.tags.map((t) => ({ Key: t.Key, Value: t.Value })),
    }),
  );

  return { permissionSetArn };
}

async function updateExistingPermissionSet(props: {
  ssoAdminClient: SSOAdminClient;
  instanceArn: string;
  permissionSetArn: string;
  permissionSetName: string;
  description: string;
  sessionDuration: string;
  logger: Logger;
}): Promise<string> {
  await props.ssoAdminClient.send(
    new UpdatePermissionSetCommand({
      InstanceArn: props.instanceArn,
      PermissionSetArn: props.permissionSetArn,
      Description: props.description,
      SessionDuration: props.sessionDuration,
    }),
  );
  props.logger.log(`Updated permission set: ${props.permissionSetName}`);
  return props.permissionSetArn;
}

async function createNewPermissionSet(props: {
  ssoAdminClient: SSOAdminClient;
  instanceArn: string;
  permissionSetName: string;
  description: string;
  sessionDuration: string;
  tags: AwsTag[];
  logger: Logger;
}): Promise<string> {
  const createResponse = await props.ssoAdminClient.send(
    new CreatePermissionSetCommand({
      InstanceArn: props.instanceArn,
      Name: props.permissionSetName,
      Description: props.description,
      SessionDuration: props.sessionDuration,
      Tags: props.tags.map((t) => ({ Key: t.Key, Value: t.Value })),
    }),
  );
  const permissionSetArn = createResponse.PermissionSet?.PermissionSetArn ?? "";
  if (permissionSetArn === "") {
    throw new Error(`Failed to create permission set "${props.permissionSetName}": ARN is empty.`);
  }
  props.logger.log(`Created permission set: ${props.permissionSetName}`);
  return permissionSetArn;
}

async function checkPendingStackSetOperations(props: {
  state: StateFile;
  lambdaClient: LambdaClient;
  lambdaArn: string;
  logger: Logger;
}): Promise<void> {
  const pending = props.state.pendingStackSetOperations;
  if (!pending || pending.length === 0) return;

  const result = await invokeLambda({
    lambdaClient: props.lambdaClient,
    lambdaArn: props.lambdaArn,
    payload: {
      action: "checkPendingStackSets" as const,
      operations: pending.map((op) => ({
        stackSetName: op.stackSetName,
        operationId: op.operationId,
      })),
    },
  });
  if (!result.ok) {
    props.logger.log("Warning: could not check pending StackSet operations.");
    return;
  }
  const response = result.response;
  if (!("results" in response)) return;

  const stillRunning = (response.results as Array<{ stackSetName: string; status: string }>).filter(
    (r) => r.status === "RUNNING" || r.status === "QUEUED",
  );
  if (stillRunning.length > 0) {
    const names = stillRunning.map((r) => r.stackSetName).join(", ");
    throw new Error(
      `StackSet operation(s) still in progress: ${names}. Please wait for them to complete before running plan/apply.`,
    );
  }
}

async function ensureLogGroup(props: {
  region: string;
  profile: string;
  retentionDays: number | undefined;
  logger: Logger;
}): Promise<void> {
  const logsClient = new CloudWatchLogsClient(buildAwsClientConfig({ profile: props.profile, region: props.region }));
  try {
    await logsClient.send(new CreateLogGroupCommand({ logGroupName: lambdaLogGroupName }));
    props.logger.log(`Created log group: ${lambdaLogGroupName}`);
  } catch (error: unknown) {
    if (!(error instanceof ResourceAlreadyExistsException)) throw error;
  }
  await logsClient.send(new TagLogGroupCommand({
    logGroupName: lambdaLogGroupName,
    tags: Object.fromEntries(getStandardTags("lambda-logs").map((t) => [t.Key, t.Value])),
  }));
  if (props.retentionDays != null) {
    await logsClient.send(new PutRetentionPolicyCommand({
      logGroupName: lambdaLogGroupName,
      retentionInDays: props.retentionDays,
    }));
  } else {
    await logsClient.send(new DeleteRetentionPolicyCommand({ logGroupName: lambdaLogGroupName }));
  }
}

async function readLambdaZip(): Promise<Buffer> {
  const thisFile = fileURLToPath(import.meta.url);
  // thisFile = <root>/dist/commands/remote.js → go up 3 levels to package root
  const packageDir = dirname(dirname(dirname(thisFile)));
  const zipPath = join(packageDir, "dist-lambda", "lambda.zip");
  try {
    return await readFile(zipPath);
  } catch {
    throw new Error(
      `Lambda zip not found at ${zipPath}. The package may be corrupted — try reinstalling @beesolve/aws-accounts.`,
    );
  }
}

async function waitForLambdaReady(lambdaClient: LambdaClient, functionName: string): Promise<void> {
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    const response = await lambdaClient.send(
      new GetFunctionCommand({ FunctionName: functionName }),
    );
    const lastUpdateStatus = response.Configuration?.LastUpdateStatus;
    if (lastUpdateStatus === "Successful" || lastUpdateStatus === undefined) {
      return;
    }
    if (lastUpdateStatus === "Failed") {
      throw new Error(
        `Lambda function update failed: ${response.Configuration?.LastUpdateStatusReason ?? "unknown reason"}`,
      );
    }
    await delay(2000);
  }
  throw new Error("Timed out waiting for Lambda function to become ready.");
}

const validStackSetNames = new Set(["security-setup", "config-recorder", "guardduty-member"]);

function computeStackSetOperations(config: AwsConfigModel, context: { managementAccountId: string; organizationId: string | undefined; region: string; ouIdsByName: Record<string, string>; deployedStackSets?: Array<{ name: string; targets: string[] }> }): StackSetOperation[] | undefined {
  const baseline = config.securityBaseline;
  if (baseline == null || baseline.stackSets.length === 0) return undefined;
  if (!context.organizationId) {
    throw new Error("Organization ID not found in context. Run 'scan' to populate it.");
  }
  const deliveryBucketName = `config-delivery-${context.organizationId}-${context.region}`;
  const deployed = context.deployedStackSets ?? [];
  return baseline.stackSets.flatMap((ss) => {
    if (!validStackSetNames.has(ss.templateKey)) return [];
    const resolvedTargets = ss.targets.map((t) => {
      const id = context.ouIdsByName[t];
      if (!id) throw new Error(`Cannot resolve OU name "${t}" to an ID. Run 'scan' first.`);
      return id;
    });
    const existing = deployed.find((d) => d.name === ss.templateKey);
    if (existing && JSON.stringify(existing.targets.sort()) === JSON.stringify(resolvedTargets.sort())) {
      return [];
    }
    return [
      {
        action: "create" as const,
        stackSetName: ss.templateKey as "security-setup" | "config-recorder" | "guardduty-member",
        targets: resolvedTargets,
        parameters: ss.parameters.map((p) => ({
          key: p.key,
          value: p.value === "{{MANAGEMENT_ACCOUNT_ID}}"
            ? context.managementAccountId
            : p.value === "{{DELIVERY_BUCKET_NAME}}"
              ? deliveryBucketName
              : p.value,
        })),
        regions: [context.region],
        ...(ss.templateKey === "security-setup" && { waitForCompletion: true }),
      },
    ];
  });
}

async function executeStackSetOperations(props: {
  stackSetOperations: StackSetOperation[];
  lambdaClient: LambdaClient;
  lambdaArn: string;
  logger: Logger;
}): Promise<Array<{ stackSetName: string; operationId: string; startedAt: string }>> {
  const pendingOps: Array<{ stackSetName: string; operationId: string; startedAt: string }> = [];
  for (const op of props.stackSetOperations) {
    props.logger.log(
      `  [stackset] deploying "${op.stackSetName}" targeting ${op.targets.join(", ")}...`,
    );

    const uploadResult = await invokeLambda({
      lambdaClient: props.lambdaClient,
      lambdaArn: props.lambdaArn,
      payload: { action: "getUploadUrl" as const, stackSetName: op.stackSetName },
    });
    if (!uploadResult.ok) {
      throw new Error(
        `Failed to get upload URL for stackset "${op.stackSetName}": ${formatLambdaError(uploadResult.error)}`,
      );
    }
    const uploadResponse = uploadResult.response;
    if (!("action" in uploadResponse) || uploadResponse.action !== "getUploadUrl") {
      throw new Error(
        `Unexpected response from Lambda getUploadUrl action for "${op.stackSetName}".`,
      );
    }

    const templateContent = await resolveTemplateContent(op.stackSetName);
    const putResponse = await fetch(uploadResponse.url, {
      method: "PUT",
      body: templateContent,
      headers: { "Content-Type": "application/x-yaml" },
    });
    if (!putResponse.ok) {
      throw new Error(`Failed to upload template for "${op.stackSetName}": ${putResponse.status}`);
    }

    const deployResult = await invokeLambda({
      lambdaClient: props.lambdaClient,
      lambdaArn: props.lambdaArn,
      payload: {
        action: "deployStackSet" as const,
        stackSetName: op.stackSetName,
        targets: op.targets,
        parameters: op.parameters,
        regions: op.regions,
        ...(op.waitForCompletion && { waitForCompletion: true }),
      },
    });
    if (!deployResult.ok) {
      throw new Error(
        `Failed to deploy stackset "${op.stackSetName}": ${formatLambdaError(deployResult.error)}`,
      );
    }
    if (!op.waitForCompletion) {
      const response = deployResult.response;
      if ("operationId" in response && typeof response.operationId === "string") {
        pendingOps.push({
          stackSetName: op.stackSetName,
          operationId: response.operationId,
          startedAt: new Date().toISOString(),
        });
      }
    }
    props.logger.log(`  [stackset] "${op.stackSetName}" deployed.`);
  }
  return pendingOps;
}

async function resolveTemplateContent(templateKey: string): Promise<string> {
  const userPath = join(process.cwd(), "templates", `${templateKey}.yaml`);
  try {
    return await readFile(userPath, "utf8");
  } catch {
    const packageDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const defaultPath = join(packageDir, "templates", `${templateKey}.yaml`);
    return await readFile(defaultPath, "utf8");
  }
}
