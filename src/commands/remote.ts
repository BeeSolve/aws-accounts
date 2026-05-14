import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import {
  BucketLocationConstraint,
  CreateBucketCommand,
  S3Client,
  type S3ServiceException,
} from "@aws-sdk/client-s3";
import {
  CreateRoleCommand,
  GetRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  CreateFunctionCommand,
  GetFunctionCommand,
  LambdaClient,
  PutFunctionConcurrencyCommand,
  ResourceNotFoundException,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
  type AwsContextFile,
  type Deployment,
  loadAwsConfigModelFromTsFile,
  mapAwsConfigToState,
  readAwsContextFromFile,
  writeAwsConfigFromState,
} from "../awsConfig.js";
import { buildAwsClientConfig } from "../awsClientConfig.js";
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

// todo: why is this not inferred from valibot schema?
export type RemoteCommandInput = {
  subcommand: "bootstrap" | "scan" | "init" | "plan" | "apply" | "upgrade";
  profile: string | undefined;
  region: string | undefined;
  flags: {
    yes: boolean;
    refresh: boolean;
    allowDestructive: boolean;
    ignoreUnsupported: boolean;
  };
  logger: Logger;
  overwriteConfirmation?: (props: { fileSummaries: string[] }) => Promise<boolean>;
};

const contextFilePath = "aws.context.json";
const configFilePath = "aws.config.ts";
const typesFilePath = "aws.config.types.ts";
const cachePath = ".remote-state-cache.json"; // todo: shouldn't be cache config same as state config? I mean if those are two separate files and now we are supporting both local and remote execution these files will go out of sync soon
const lambdaZipPath = "dist-lambda/lambda.zip";
const lambdaRoleName = "beesolve-aws-accounts-lambda-role";
const lambdaFunctionName = "beesolve-aws-accounts";

// --- Bootstrap ---

export async function runRemoteBootstrap(input: RemoteCommandInput): Promise<void> {
  const { logger } = input;

  // todo: extract this to separate helper to avoid using let
  // Read lambda zip
  let lambdaZip: Buffer;
  try {
    lambdaZip = await readFile(resolve(lambdaZipPath));
  } catch {
    throw new Error("dist-lambda/lambda.zip not found. Run `npm run build:lambda` first.");
  }

  const clientConfig = buildAwsClientConfig({
    profile: input.profile,
    region: input.region,
  });

  // Get account ID and region
  const stsClient = new STSClient(clientConfig);
  const callerIdentity = await stsClient.send(new GetCallerIdentityCommand({}));
  const accountId = callerIdentity.Account;
  if (accountId == null) {
    throw new Error("Could not determine AWS account ID from STS.");
  }

  const resolvedRegion = input.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const bucketName = `beesolve-aws-accounts-state-${accountId}-${resolvedRegion}`;

  logger.log(`Account: ${accountId}`);
  logger.log(`Region: ${resolvedRegion}`);
  logger.log(`Bucket: ${bucketName}`);

  // todo: all AWS clients should be passed by property so it's easier to write tests - as the rest of the codebase
  // Create S3 bucket
  const s3Client = new S3Client(clientConfig);
  try {
    // todo: why is this cast as any?
    // const createBucketInput: any = { Bucket: bucketName };
    // if (resolvedRegion !== "us-east-1") {
    //   createBucketInput.CreateBucketConfiguration = {
    //     LocationConstraint: resolvedRegion,
    //   };
    // }
    await s3Client.send(new CreateBucketCommand({
      Bucket: bucketName,
      // would this change be acceptable?
      CreateBucketConfiguration: resolvedRegion !== "us-east-1"?{
        LocationConstraint: 
          resolvedRegion as BucketLocationConstraint,
      }: undefined
    }));
    logger.log(`Created S3 bucket: ${bucketName}`);
  } catch (error: unknown) {
    const s3Error = error as S3ServiceException;
    if (
      s3Error.name === "BucketAlreadyOwnedByYou" ||
      s3Error.name === "BucketAlreadyExists"
    ) {
      logger.log(`S3 bucket already exists: ${bucketName}`);
    } else {
      throw error;
    }
  }

  // todo: all clients should be passed as properties
  // Create IAM role
  const iamClient = new IAMClient(clientConfig);
  const { roleArn, created: roleCreated } = await ensureIamRole({
    iamClient,
    accountId,
    bucketName,
    logger,
  });

  // extract delay function to helpers and reuse it here as well - also shouldn't we wait in loop until some condition is done + timeout?
  // IAM is eventually consistent — wait for the role to be assumable
  if (roleCreated) {
    logger.log("Waiting for IAM role to propagate...");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  // todo: all clients should be passed as properties
  // Create or update Lambda function
  const lambdaClient = new LambdaClient(clientConfig);
  const lambdaArn = await ensureLambdaFunction({
    lambdaClient,
    roleArn,
    lambdaZip,
    bucketName,
    resolvedRegion,
    logger,
  });

  // Persist deployment to context file
  const context = await readAwsContextFromFile(contextFilePath);
  const deployment: Deployment = {
    profile: input.profile ?? "",
    region: resolvedRegion,
    lambdaArn,
    stateBucketName: bucketName,
    stateCacheTtlSeconds: 300,
  };

  const updatedContext: AwsContextFile = {
    ...context,
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

  logger.log("");
  logger.log("Bootstrap complete.");
  logger.log(`  Lambda ARN: ${lambdaArn}`);
  logger.log(`  State bucket: ${bucketName}`);
}

async function ensureIamRole(props: {
  iamClient: IAMClient;
  accountId: string;
  bucketName: string;
  logger: Logger;
}): Promise<{ roleArn: string; created: boolean }> {
  const { iamClient, accountId, bucketName, logger } = props;

  const trustPolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  });

  let roleArn: string;
  let created = false;
  try {
    const getRole = await iamClient.send(
      new GetRoleCommand({ RoleName: lambdaRoleName }),
    );
    roleArn = getRole.Role?.Arn ?? "";
    if (roleArn === "") {
      throw new Error("IAM role exists but ARN is empty.");
    }
    logger.log(`IAM role already exists: ${lambdaRoleName}`);
  } catch (error: unknown) {
    if ((error as any).name === "NoSuchEntityException") {
      const createRole = await iamClient.send(
        new CreateRoleCommand({
          RoleName: lambdaRoleName,
          AssumeRolePolicyDocument: trustPolicy,
          Description: "Execution role for beesolve-aws-accounts Lambda",
        }),
      );
      roleArn = createRole.Role?.Arn ?? "";
      if (roleArn === "") {
        throw new Error("Failed to create IAM role: ARN is empty.");
      }
      created = true;
      logger.log(`Created IAM role: ${lambdaRoleName}`);
    } else {
      throw error;
    }
  }

  // Attach inline policy
  const inlinePolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["organizations:*"],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: ["sso:*", "identitystore:*"],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
        Resource: [
          `arn:aws:s3:::${bucketName}`,
          `arn:aws:s3:::${bucketName}/*`,
        ],
      },
      {
        Effect: "Allow",
        Action: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        Resource: "arn:aws:logs:*:*:*",
      },
      {
        Effect: "Allow",
        Action: ["account:PutAccountName"],
        Resource: "*",
      },
    ],
  });

  await iamClient.send(
    new PutRolePolicyCommand({
      RoleName: lambdaRoleName,
      PolicyName: "beesolve-aws-accounts-execution-policy",
      PolicyDocument: inlinePolicy,
    }),
  );

  return { roleArn, created };
}

async function ensureLambdaFunction(props: {
  lambdaClient: LambdaClient;
  roleArn: string;
  lambdaZip: Buffer;
  bucketName: string;
  resolvedRegion: string;
  logger: Logger;
}): Promise<string> {
  // todo: do not extract properties, just use props.* directly
  const { lambdaClient, roleArn, lambdaZip, bucketName, logger } = props;

  try {
    // Check if function already exists
    const getFunction = await lambdaClient.send(
      new GetFunctionCommand({ FunctionName: lambdaFunctionName }),
    );
    const existingArn = getFunction.Configuration?.FunctionArn ?? "";
    if (existingArn === "") {
      throw new Error("Lambda function exists but ARN is empty.");
    }

    // Update function code
    await lambdaClient.send(
      new UpdateFunctionCodeCommand({
        FunctionName: lambdaFunctionName,
        ZipFile: lambdaZip,
      }),
    );

    // Ensure environment variables are set
    await lambdaClient.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: lambdaFunctionName,
        Environment: {
          Variables: {
            STATE_BUCKET_NAME: bucketName,
          },
        },
      }),
    );

    logger.log(`Updated Lambda function code: ${lambdaFunctionName}`);
    return existingArn;
  } catch (error: unknown) {
    if (error instanceof ResourceNotFoundException) {
      // Create new function
      const createResult = await lambdaClient.send(
        new CreateFunctionCommand({
          FunctionName: lambdaFunctionName,
          Runtime: "nodejs24.x",
          Handler: "handler.handler",
          Role: roleArn,
          Code: { ZipFile: lambdaZip },
          Timeout: 900,
          MemorySize: 512,
          PackageType: "Zip",
          Architectures: ["arm64"],
          Environment: {
            Variables: {
              STATE_BUCKET_NAME: bucketName,
            },
          },
        }),
      );
      const lambdaArn = createResult.FunctionArn ?? "";
      if (lambdaArn === "") {
        throw new Error("Failed to create Lambda function: ARN is empty.");
      }

      // Set reserved concurrency to 1
      await lambdaClient.send(
        new PutFunctionConcurrencyCommand({
          FunctionName: lambdaFunctionName,
          ReservedConcurrentExecutions: 1,
        }),
      );

      logger.log(`Created Lambda function: ${lambdaFunctionName}`);
      logger.log(`Set reserved concurrency to 1`);
      return lambdaArn;
    }
    throw error;
  }
}


// --- Scan ---

export async function runRemoteScan(input: RemoteCommandInput): Promise<void> {
  const { logger } = input;

  const deployment = await readDeploymentFromContext();

  const clientConfig = buildAwsClientConfig({
    profile: input.profile ?? (deployment.profile || undefined),
    region: input.region ?? (deployment.region || undefined),
  });
  const lambdaClient = new LambdaClient(clientConfig);

  logger.log("Invoking remote scan...");
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

  logger.log("Scan complete.");
  logger.log(`  Organizational Units: ${response.summary.organizationalUnits}`);
  logger.log(`  Accounts: ${response.summary.accounts}`);
  logger.log(`  Users: ${response.summary.users}`);
  logger.log(`  Groups: ${response.summary.groups}`);
  logger.log(`  Permission Sets: ${response.summary.permissionSets}`);
  logger.log(`  Account Assignments: ${response.summary.accountAssignments}`);

  await writeStateCache(cachePath, response.state);
  logger.log("State cache updated.");
}

// --- Init ---

const statePath = "state.json";

export async function runRemoteInit(input: RemoteCommandInput): Promise<void> {
  const { logger } = input;

  const deployment = await readDeploymentFromContext();

  const clientConfig = buildAwsClientConfig({
    profile: input.profile ?? (deployment.profile || undefined),
    region: input.region ?? (deployment.region || undefined),
  });
  // todo: should be passed as props
  const lambdaClient = new LambdaClient(clientConfig);

  logger.log("Invoking remote scan...");
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

  logger.log("Scan complete.");
  logger.log(`  Organizational Units: ${response.summary.organizationalUnits}`);
  logger.log(`  Accounts: ${response.summary.accounts}`);
  logger.log(`  Users: ${response.summary.users}`);
  logger.log(`  Groups: ${response.summary.groups}`);
  logger.log(`  Permission Sets: ${response.summary.permissionSets}`);
  logger.log(`  Account Assignments: ${response.summary.accountAssignments}`);

  // Write state to state.json and update cache
  await writeFile(statePath, `${JSON.stringify(response.state, null, 2)}\n`, "utf8");
  await writeStateCache(cachePath, response.state);
  logger.log("State written to state.json and cache updated.");

  // Generate aws.config.ts + aws.config.types.ts from state
  if (input.overwriteConfirmation == null) {
    throw new Error("overwriteConfirmation is required for remote init.");
  }

  const configWriteResult = await writeAwsConfigFromState({
    statePath,
    contextPath: contextFilePath,
    configPath: configFilePath,
    typesPath: typesFilePath,
    logger,
    overwriteConfirmation: input.overwriteConfirmation,
  });

  const writtenFiles = configWriteResult.files.filter((f) => f.status === "written");
  if (writtenFiles.length > 0) {
    logger.log("");
    logger.log("Init complete.");
    for (const file of writtenFiles) {
      logger.log(`  ${file.path}: ${file.status}`);
    }
  }
}

// --- Plan ---

export async function runRemotePlan(input: RemoteCommandInput): Promise<void> {
  const { logger } = input;

  const deployment = await readDeploymentFromContext();
  const currentState = await fetchCurrentState({
    input,
    deployment,
  });

  // todo: why are these not being called in parallel via Promise.all?
  const context = await readAwsContextFromFile(contextFilePath);
  const config = await loadAwsConfigModelFromTsFile({
    configPath: configFilePath,
    typesPath: typesFilePath,
  });

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

  displayPlan({ plan, logger });
}

// --- Apply ---

export async function runRemoteApply(input: RemoteCommandInput): Promise<void> {
  const { logger, flags } = input;

  const deployment = await readDeploymentFromContext();
  const currentState = await fetchCurrentState({
    input,
    deployment,
  });

  // todo: call these within Promise.all
  const context = await readAwsContextFromFile(contextFilePath);
  const config = await loadAwsConfigModelFromTsFile({
    configPath: configFilePath,
    typesPath: typesFilePath,
  });

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
    logger.log("No changes.");
    return;
  }

  displayPlan({ plan, logger });

  // Prompt for confirmation
  if (!flags.yes) {
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
        logger.log("Apply cancelled.");
        return;
      }
    } finally {
      readlineInterface.close();
    }
  }

  // Invoke Lambda with apply action
  const clientConfig = buildAwsClientConfig({
    profile: input.profile ?? (deployment.profile || undefined),
    region: input.region ?? (deployment.region || undefined),
  });
  const lambdaClient = new LambdaClient(clientConfig);

  logger.log("Applying changes remotely...");
  const result = await invokeLambda({
    lambdaClient,
    lambdaArn: deployment.lambdaArn,
    payload: {
      action: "apply",
      operations: plan.operations,
      allowDestructive: flags.allowDestructive,
    },
  });

  if (!result.ok) {
    const error = result.error;
    if (error.kind === "concurrencyConflict") {
      logger.log("Another apply is in progress. Retry later.");
      return;
    }
    if (error.kind === "operationFailed") {
      logger.log(
        `Apply failed at operation ${error.failedOperation + 1} of ${error.totalOperations}: ${error.error}`,
      );
      await writeStateCache(cachePath, error.partialState);
      logger.log("State cache updated with partial state.");
      return;
    }
    throw new Error(formatLambdaError(error));
  }

  const response = result.response;
  if (!("action" in response) || response.action !== "apply") {
    throw new Error("Unexpected response from Lambda apply action.");
  }

  logger.log(`Applied ${response.operationsCompleted} operation(s).`);
  await writeStateCache(cachePath, response.state);
  logger.log("State cache updated.");
}

// --- Upgrade ---

export async function runRemoteUpgrade(input: RemoteCommandInput): Promise<void> {
  const { logger } = input;

  const deployment = await readDeploymentFromContext();

  // Read lambda zip
  let lambdaZip: Buffer;
  try {
    lambdaZip = await readFile(resolve(lambdaZipPath));
  } catch {
    throw new Error("dist-lambda/lambda.zip not found. Run `npm run build:lambda` first.");
  }

  const clientConfig = buildAwsClientConfig({
    profile: input.profile ?? (deployment.profile || undefined),
    region: input.region ?? (deployment.region || undefined),
  });
  // todo: pass by props
  const lambdaClient = new LambdaClient(clientConfig);

  logger.log(`Updating Lambda function code: ${deployment.lambdaArn}`);
  const updateResult = await lambdaClient.send(
    new UpdateFunctionCodeCommand({
      FunctionName: deployment.lambdaArn,
      ZipFile: lambdaZip,
    }),
  );

  const lastModified = updateResult.LastModified ?? "unknown";
  logger.log(`Upgrade complete. Last modified: ${lastModified}`);
}


// --- Helpers ---

async function readDeploymentFromContext(): Promise<Deployment> {
  const context = await readAwsContextFromFile(contextFilePath);
  if (context.deployment == null) {
    throw new Error(
      "No deployment found in aws.context.json. Run `aws-accounts remote bootstrap` first.",
    );
  }
  return context.deployment;
}

async function fetchCurrentState(props: {
  input: RemoteCommandInput;
  deployment: Deployment;
}): Promise<StateFile> {
  const { input, deployment } = props;

  // Check cache freshness
  if (!input.flags.refresh) {
    const cache = await readStateCache(cachePath);
    if (cache != null && isCacheFresh(cache, deployment.stateCacheTtlSeconds)) {
      input.logger.log("Using cached state.");
      return cache.state;
    }
  }

  // Fetch fresh state via pre-signed URL
  input.logger.log("Fetching remote state...");
  const clientConfig = buildAwsClientConfig({
    profile: input.profile ?? (deployment.profile || undefined),
    region: input.region ?? (deployment.region || undefined),
  });
  const lambdaClient = new LambdaClient(clientConfig);

  const result = await invokeLambda({
    lambdaClient,
    lambdaArn: deployment.lambdaArn,
    payload: { action: "getStateUrl" },
  });

  if (!result.ok) {
    throw new Error(formatLambdaError(result.error));
  }

  const response = result.response;
  if (!("action" in response) || response.action !== "getStateUrl") {
    throw new Error("Unexpected response from Lambda getStateUrl action.");
  }

  // Fetch state from pre-signed URL
  const stateResponse = await fetch(response.url);
  if (!stateResponse.ok) {
    throw new Error(
      `Failed to fetch state from pre-signed URL: ${stateResponse.status} ${stateResponse.statusText}`,
    );
  }

  const stateJson = await stateResponse.json();
  const state = validateState(stateJson);

  await writeStateCache(cachePath, state);
  input.logger.log("State cache updated.");

  return state;
}

function displayPlan(props: { plan: Plan; logger: Logger }): void {
  const { plan, logger } = props;

  logger.log(
    `Plan: ${plan.operations.length} operation(s), ${plan.unsupported.length} unsupported diff(s)`,
  );

  const destructiveOperations = plan.operations.filter((op) =>
    isDestructiveOperation(op),
  );
  if (destructiveOperations.length > 0) {
    logger.log(
      `Destructive operations detected: ${destructiveOperations.length}. Apply requires --allow-destructive.`,
    );
  }

  for (const operation of plan.operations) {
    logger.log(formatOperationLine(operation));
  }

  if (plan.unsupported.length > 0) {
    logger.log("Unsupported diffs:");
    for (const diff of plan.unsupported) {
      logger.log(`  - ${diff.description} [${diff.category}]`);
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
  // todo: use assert unreachable here
  // Exhaustive — should never reach here
  const _exhaustive: never = operation;
  return `  ${(operation as any).kind}`;
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
