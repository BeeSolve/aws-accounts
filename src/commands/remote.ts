import { readFile, writeFile } from "node:fs/promises";
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
  CreatePermissionSetCommand,
  DescribePermissionSetCommand,
  ListPermissionSetsCommand,
  PutInlinePolicyToPermissionSetCommand,
  SSOAdminClient,
  TagResourceCommand as SsoTagResourceCommand,
  UpdatePermissionSetCommand,
} from "@aws-sdk/client-sso-admin";
import {
  type AwsContextFile,
  type Deployment,
  loadAwsConfigModelFromTsFile,
  mapAwsConfigToState,
  readAwsContextFromFile,
  regenerateTypesFromState,
  writeAwsConfigFromState,
} from "../awsConfig.js";
import { buildAwsClientConfig } from "../awsClientConfig.js";
import { getStandardTags } from "../tags.js";
import type { AwsTag } from "../tags.js";
import { diffStates } from "../diff.js";
import { invokeLambda } from "../lambdaClient.js";
import type { Logger } from "../logger.js";
import type { Operation, Plan } from "../operations.js";
import {
  isCacheFresh,
  readStateCache,
  writeStateCache,
} from "../remoteStateCache.js";
import { applyReservedOuDeletionGuard } from "../reservedOuDeletion.js";
import { validateState, type StateFile } from "../state.js";
import { assertUnreachable, delay } from "../helpers.js";
import { iam } from "@beesolve/iam-policy-ts";

const remoteCommandSchema = v.object({
  subcommand: v.picklist(["bootstrap", "scan", "init", "plan", "apply", "upgrade"]),
  profile: v.optional(v.string()),
  region: v.optional(v.string()),
  flags: v.object({
    yes: v.boolean(),
    refresh: v.boolean(),
    allowDestructive: v.boolean(),
    ignoreUnsupported: v.boolean(),
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
const typesFilePath = "aws.config.types.ts";
const cachePath = ".remote-state-cache.json";
const lambdaRoleName = "beesolve-aws-accounts-lambda-role";
const lambdaFunctionName = "beesolve-aws-accounts";


export async function runRemoteBootstrap(input: RemoteCommandInput): Promise<void> {
  const lambdaZip = await readLambdaZip();

  const callerIdentity = await input.stsClient.send(new GetCallerIdentityCommand({}));
  const accountId = callerIdentity.Account;
  if (accountId == null) {
    throw new Error("Could not determine AWS account ID from STS.");
  }

  const resolvedRegion = input.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const bucketName = `beesolve-aws-accounts-state-${accountId}-${resolvedRegion}`;

  input.logger.log(`Account: ${accountId}`);
  input.logger.log(`Region: ${resolvedRegion}`);
  input.logger.log(`Bucket: ${bucketName}`);

  try {
    await input.s3Client.send(new CreateBucketCommand({
      Bucket: bucketName,
      CreateBucketConfiguration: resolvedRegion !== "us-east-1" ? {
        LocationConstraint:
          resolvedRegion as BucketLocationConstraint,
      } : undefined
    }));
    input.logger.log(`Created S3 bucket: ${bucketName}`);
  } catch (error: unknown) {
    const s3Error = error as S3ServiceException;
    if (
      s3Error.name === "BucketAlreadyOwnedByYou" ||
      s3Error.name === "BucketAlreadyExists"
    ) {
      input.logger.log(`S3 bucket already exists: ${bucketName}`);
    } else {
      throw error;
    }
  }

  await input.s3Client.send(new PutBucketTaggingCommand({
    Bucket: bucketName,
    Tagging: {
      TagSet: getStandardTags("state-storage"),
    },
  }));

  const { roleArn } = await ensureIamRole({
    iamClient: input.iamClient,
    bucketName,
    logger: input.logger,
  });

  const lambdaArn = await ensureLambdaFunction({
    lambdaClient: input.lambdaClient,
    roleArn,
    lambdaZip,
    bucketName,
    resolvedRegion,
    logger: input.logger,
  });

  // Persist deployment to context file
  let context: AwsContextFile | null = null;
  try {
    context = await readAwsContextFromFile(contextFilePath);
  } catch {
    // File doesn't exist yet on fresh bootstrap — that's expected
  }
  const deployment: Deployment = {
    profile: input.profile ?? "",
    region: resolvedRegion,
    lambdaArn,
    stateBucketName: bucketName,
    stateCacheTtlSeconds: 300,
  };

  const updatedContext = context != null
    ? { ...context, deployment }
    : {
      version: "1",
      generatedAt: new Date().toISOString(),
      organization: { managementAccountId: accountId, rootId: "pending", graveyardOuId: "pending" },
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

  const instanceArn = updatedContext.identityCenter?.instanceArn;

  if (instanceArn != null && instanceArn !== "" && instanceArn !== "pending") {
    await ensureOrganizationManagementPermissionSet({
      ssoAdminClient: input.ssoAdminClient,
      instanceArn,
      tags: getStandardTags("organization-management"),
      logger: input.logger,
    })
      .catch((error: unknown) => {
        input.logger.log(`Error creating OrganizationManagement permission set: ${error instanceof Error ? error.message : String(error)}`);
      });

    await ensureOrganizationRemoteManagementPermissionSet({
      ssoAdminClient: input.ssoAdminClient,
      instanceArn,
      lambdaArn,
      tags: getStandardTags("remote-invocation"),
      logger: input.logger,
    })
      .catch((error: unknown) => {
        input.logger.log(`Error creating OrganizationRemoteManagement permission set: ${error instanceof Error ? error.message : String(error)}`);
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
        Action: iam.sts("AssumeRole"),
      },
    ],
  });

  const { roleArn } = await getOrCreateIamRole({
    iamClient: props.iamClient,
    trustPolicy,
    logger: props.logger,
  });

  const inlinePolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: iam.organizations("*"),
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: [iam.sso('*'), iam.identitystore('*')],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: [iam.s3("GetObject"), iam.s3("PutObject"), iam.s3("ListBucket")],
        Resource: [
          `arn:aws:s3:::${props.bucketName}`,
          `arn:aws:s3:::${props.bucketName}/*`,
        ],
      },
      {
        Effect: "Allow",
        Action: [
          iam.logs("CreateLogGroup"),
          iam.logs("CreateLogStream"),
          iam.logs("PutLogEvents"),
        ],
        Resource: "arn:aws:logs:*:*:*",
      },
      {
        Effect: "Allow",
        Action: [iam.account("PutAccountName")],
        Resource: "*",
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

  return { roleArn };
}

async function getOrCreateIamRole(props: {
  iamClient: IAMClient;
  trustPolicy: string;
  logger: Logger;
}): Promise<{ roleArn: string }> {
  try {
    const getRole = await props.iamClient.send(
      new GetRoleCommand({ RoleName: lambdaRoleName }),
    );
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

    // Ensure environment variables are set
    await props.lambdaClient.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: lambdaFunctionName,
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
        Tags: Object.fromEntries(getStandardTags("remote-execution").map(t => [t.Key, t.Value])),
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
          Timeout: 900,
          MemorySize: 512,
          PackageType: "Zip",
          Architectures: ["arm64"],
          Environment: {
            Variables: {
              STATE_BUCKET_NAME: props.bucketName,
            },
          },
          Tags: Object.fromEntries(getStandardTags("remote-execution").map(t => [t.Key, t.Value])),
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
      props.logger.log(`Waiting for IAM role to propagate (attempt ${attempt}/${IAM_PROPAGATION_MAX_ATTEMPTS})...`);
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
  const result = await invokeLambda({
    lambdaClient,
    lambdaArn: deployment.lambdaArn,
    payload: { action: "scan" },
  });

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

  await writeStateCache(cachePath, response.state);
  input.logger.log("State cache updated.");
}

const statePath = "state.json";

export async function runRemoteInit(input: RemoteCommandInput): Promise<void> {
  const deployment = await readDeploymentFromContext();

  input.logger.log("Invoking remote scan...");
  const result = await invokeLambda({
    lambdaClient: input.lambdaClient,
    lambdaArn: deployment.lambdaArn,
    payload: { action: "scan" },
  });

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

  await Promise.all([
    writeFile(statePath, `${JSON.stringify(response.state, null, 2)}\n`, "utf8"),
    writeStateCache(cachePath, response.state),
  ]);
  input.logger.log("State written to state.json and cache updated.");

  const configWriteResult = await writeAwsConfigFromState({
    statePath,
    contextPath: contextFilePath,
    configPath: configFilePath,
    typesPath: typesFilePath,
    logger: input.logger,
    overwriteConfirmation: input.overwriteConfirmation,
  });

  const writtenFiles = configWriteResult.files.filter((f) => f.status === "written");
  if (writtenFiles.length > 0) {
    input.logger.log("");
    input.logger.log("Init complete.");
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

  const [context, config] = await Promise.all([
    readAwsContextFromFile(contextFilePath),
    loadAwsConfigModelFromTsFile({
      configPath: configFilePath,
      typesPath: typesFilePath,
    }),
  ]);

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

  displayPlan({ plan, logger: input.logger });
}

export async function runRemoteApply(input: RemoteCommandInput): Promise<void> {
  const deployment = await readDeploymentFromContext();
  const currentState = await fetchCurrentState({
    input,
    deployment,
  });

  const [context, config] = await Promise.all([
    readAwsContextFromFile(contextFilePath),
    loadAwsConfigModelFromTsFile({
      configPath: configFilePath,
      typesPath: typesFilePath,
    }),
  ]);

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

  if (plan.operations.length === 0) {
    input.logger.log("No changes.");
    return;
  }

  displayPlan({ plan, logger: input.logger });

  if (!input.flags.yes) {
    if (process.stdin.isTTY !== true) {
      throw new Error(
        "Refusing to apply changes in non-interactive mode without --yes.",
      );
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

  input.logger.log("Applying changes remotely...");
  const result = await invokeLambda({
    lambdaClient,
    lambdaArn: deployment.lambdaArn,
    payload: {
      action: "apply",
      operations: plan.operations,
      allowDestructive: input.flags.allowDestructive,
    },
  });

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
  input.logger.log("State cache updated.");

  await regenerateTypesFromState({
    state: response.state,
    contextPath: contextFilePath,
    configPath: configFilePath,
    typesPath: typesFilePath,
    logger: input.logger,
  });
}

export async function runRemoteUpgrade(input: RemoteCommandInput): Promise<void> {
  const deployment = await readDeploymentFromContext();

  const lambdaZip = await readLambdaZip();

  input.logger.log(`Updating Lambda function code: ${deployment.lambdaArn}`);
  await waitForLambdaReady(input.lambdaClient, deployment.lambdaArn);
  const updateResult = await input.lambdaClient.send(
    new UpdateFunctionCodeCommand({
      FunctionName: deployment.lambdaArn,
      ZipFile: lambdaZip,
    }),
  );

  const lastModified = updateResult.LastModified ?? "unknown";
  input.logger.log(`Upgrade complete. Last modified: ${lastModified}`);
}

async function readDeploymentFromContext(): Promise<Deployment> {
  const context = await readAwsContextFromFile(contextFilePath);
  if (context.deployment == null) {
    throw new Error(
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
      props.input.logger.log("Using cached state.");
      return cache.state;
    }
  }

  props.input.logger.log("Fetching remote state...");
  const clientConfig = buildAwsClientConfig({
    profile: props.input.profile ?? (props.deployment.profile || undefined),
    region: props.input.region ?? (props.deployment.region || undefined),
  });
  const lambdaClient = new LambdaClient(clientConfig);

  const result = await invokeLambda({
    lambdaClient,
    lambdaArn: props.deployment.lambdaArn,
    payload: { action: "getStateUrl" },
  });

  if (!result.ok) {
    throw new Error(formatLambdaError(result.error));
  }

  const response = result.response;
  if (!("action" in response) || response.action !== "getStateUrl") {
    throw new Error("Unexpected response from Lambda getStateUrl action.");
  }

  const stateResponse = await fetch(response.url);
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

function displayPlan(props: { plan: Plan; logger: Logger }): void {
  props.logger.log(
    `Plan: ${props.plan.operations.length} operation(s), ${props.plan.unsupported.length} unsupported diff(s)`,
  );

  const destructiveOperations = props.plan.operations.filter((op) =>
    isDestructiveOperation(op),
  );
  if (destructiveOperations.length > 0) {
    props.logger.log(
      `Destructive operations detected: ${destructiveOperations.length}. Apply requires --allow-destructive.`,
    );
  }

  for (const operation of props.plan.operations) {
    props.logger.log(formatOperationLine(operation));
  }

  if (props.plan.unsupported.length > 0) {
    props.logger.log("Unsupported diffs:");
    for (const diff of props.plan.unsupported) {
      props.logger.log(`  - ${diff.description} [${diff.category}]`);
    }
  }
}

function isDestructiveOperation(operation: Operation): boolean {
  return (
    operation.kind === "deleteOu" ||
    operation.kind === "removeAccount" ||
    operation.kind === "deleteIdcUser" ||
    operation.kind === "deleteIdcGroup" ||
    operation.kind === "deleteIdcPermissionSet"
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
  if (operation.kind === "removeIdcGroupMembership") {
    return `  remove user "${operation.userName}" from IdC group "${operation.groupDisplayName}"`;
  }
  if (operation.kind === "grantIdcAccountAssignment") {
    return `  grant IdC assignment "${operation.permissionSetName}" to ${formatPrincipalLabel(operation.principalType, operation.principalName)} on "${operation.accountName}"`;
  }
  if (operation.kind === "revokeIdcAccountAssignment") {
    return `  revoke IdC assignment "${operation.permissionSetName}" from ${formatPrincipalLabel(operation.principalType, operation.principalName)} on "${operation.accountName}"`;
  }
  assertUnreachable(operation, "Unsupported operation kind in formatOperationLine.");
}

function formatPrincipalLabel(
  principalType: "GROUP" | "USER",
  principalName: string,
): string {
  if (principalType === "GROUP") {
    return `group "${principalName}"`;
  }
  return `user "${principalName}"`;
}

function formatLambdaError(error: {
  kind: string;
  [key: string]: unknown;
}): string {
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
  const description = "Full organization management access for AWS Organizations, IAM Identity Center, and IAM";
  const sessionDuration = "PT4H";

  const inlinePolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: [iam.organizations("*"), iam.sso("*"), iam.identitystore("*"), iam.account("*"), iam.iam("*")],
      Resource: "*",
    }],
  });

  const existingArn = await findPermissionSetByName({
    ssoAdminClient: props.ssoAdminClient,
    instanceArn: props.instanceArn,
    name: permissionSetName,
  });

  const permissionSetArn = existingArn != null
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
      Tags: props.tags.map(t => ({ Key: t.Key, Value: t.Value })),
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
    Statement: [{
      Effect: "Allow",
      Action: [iam.lambda("InvokeFunction")],
      Resource: props.lambdaArn,
    }],
  });

  const existingArn = await findPermissionSetByName({
    ssoAdminClient: props.ssoAdminClient,
    instanceArn: props.instanceArn,
    name: permissionSetName,
  });

  const permissionSetArn = existingArn != null
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
      Tags: props.tags.map(t => ({ Key: t.Key, Value: t.Value })),
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
      Tags: props.tags.map(t => ({ Key: t.Key, Value: t.Value })),
    }),
  );
  const permissionSetArn = createResponse.PermissionSet?.PermissionSetArn ?? "";
  if (permissionSetArn === "") {
    throw new Error(`Failed to create permission set "${props.permissionSetName}": ARN is empty.`);
  }
  props.logger.log(`Created permission set: ${props.permissionSetName}`);
  return permissionSetArn;
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

async function waitForLambdaReady(
  lambdaClient: LambdaClient,
  functionName: string,
): Promise<void> {
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