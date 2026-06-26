import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import type { IAMClient } from "@aws-sdk/client-iam";
import { CreateRoleCommand, GetRoleCommand, TagRoleCommand } from "@aws-sdk/client-iam";
import type { LambdaClient } from "@aws-sdk/client-lambda";
import {
  CreateFunctionCommand,
  GetFunctionCommand,
  PutFunctionConcurrencyCommand,
  ResourceNotFoundException,
  TagResourceCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import {
  CreateOrganizationCommand,
  DescribeOrganizationCommand,
} from "@aws-sdk/client-organizations";
import type { BucketLocationConstraint } from "@aws-sdk/client-s3";
import {
  CreateBucketCommand,
  PutBucketTaggingCommand,
  type S3ServiceException,
} from "@aws-sdk/client-s3";
import type { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import {
  CreatePermissionSetCommand,
  DescribePermissionSetCommand,
  ListInstancesCommand,
  ListPermissionSetsCommand,
  PutInlinePolicyToPermissionSetCommand,
  TagResourceCommand as SsoTagResourceCommand,
  UpdatePermissionSetCommand,
} from "@aws-sdk/client-sso-admin";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  account,
  iam,
  identitystore,
  lambda,
  organizations,
  sso,
  sts,
} from "@beesolve/iam-policy-ts";

import type { AwsContextFile, Deployment } from "../awsConfig.js";
import { readAwsContextFromFile, readPackageVersion } from "../awsConfig.js";
import { toPreconditionError } from "../error.js";
import { delay } from "../helpers.js";
import type { Logger } from "../logger.js";
import type { AwsTag } from "../tags.js";
import { getStandardTags } from "../tags.js";
import type { RemoteCommandInput } from "./remote.js";
import {
  applyLambdaRolePolicy,
  contextFilePath,
  ensureLogGroup,
  lambdaFunctionName,
  lambdaRoleName,
  readLambdaZip,
  waitForLambdaReady,
} from "./remote.js";

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

  await ensureOrganization({ input });
  await ensureIdentityCenter({ input, region: resolvedRegion });

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
  input.logger.log("");
  input.logger.log("Next steps:");
  input.logger.log("  1. Run 'init' to scan your AWS org and generate aws.config.ts");
  input.logger.log("  2. Edit aws.config.ts to define your desired state");
  input.logger.log("  3. Run 'plan' to preview changes, then 'apply' to execute them");
}

async function ensureOrganization(props: { input: RemoteCommandInput }): Promise<void> {
  let orgExists = true;
  let featureSet: string | undefined;

  try {
    const response = await props.input.organizationsClient.send(
      new DescribeOrganizationCommand({}),
    );
    featureSet = response.Organization?.FeatureSet;
  } catch (error: unknown) {
    if ((error as { name?: string }).name === "AWSOrganizationsNotInUseException") {
      orgExists = false;
    } else {
      throw error;
    }
  }

  if (orgExists && featureSet === "CONSOLIDATED_BILLING") {
    throw toPreconditionError(
      'AWS Organization exists but only has "consolidated billing" enabled. ' +
        '"All features" is required.\n' +
        "Enable all features: https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_org_support-all-features.html",
    );
  }

  if (orgExists) {
    props.input.logger.log("AWS Organization: exists (all features enabled)");
    return;
  }

  props.input.logger.log("");
  props.input.logger.log("No AWS Organization detected.");
  props.input.logger.log(
    "An Organization with all features enabled is required for this tool to work.",
  );
  props.input.logger.log("");

  if (!props.input.flags.yes) {
    if (process.stdin.isTTY !== true) {
      throw toPreconditionError(
        "No AWS Organization found. Create one manually or re-run with --yes to create automatically.",
      );
    }
    const readlineInterface = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await readlineInterface.question(
        "Create an AWS Organization with all features enabled? [y/N] ",
      );
      const normalized = answer.trim().toLowerCase();
      if (normalized !== "y" && normalized !== "yes") {
        props.input.logger.log("Bootstrap cancelled.");
        return;
      }
    } finally {
      readlineInterface.close();
    }
  }

  await props.input.organizationsClient.send(new CreateOrganizationCommand({ FeatureSet: "ALL" }));
  props.input.logger.log("Created AWS Organization with all features enabled.");
}

async function ensureIdentityCenter(props: {
  input: RemoteCommandInput;
  region: string;
}): Promise<void> {
  const response = await props.input.ssoAdminClient.send(new ListInstancesCommand({}));
  if ((response.Instances ?? []).length > 0) {
    props.input.logger.log("IAM Identity Center: enabled");
    return;
  }

  const consoleUrl = `https://${props.region}.console.aws.amazon.com/singlesignon/home?region=${props.region}#/`;

  props.input.logger.log("");
  props.input.logger.log("IAM Identity Center is not enabled.");
  props.input.logger.log(
    "This must be done manually via the AWS Console (no API exists for organization-level instances).",
  );
  props.input.logger.log("");
  props.input.logger.log("Steps:");
  props.input.logger.log(`  1. Open: ${consoleUrl}`);
  props.input.logger.log('  2. Click "Enable"');
  props.input.logger.log(
    '  3. Keep the default identity source ("Identity Center directory") unless you plan to use an external IdP',
  );
  props.input.logger.log("");

  if (process.stdin.isTTY !== true) {
    throw toPreconditionError(
      "IAM Identity Center is not enabled. Enable it via the AWS Console and re-run bootstrap.",
    );
  }

  const readlineInterface = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (true) {
      await readlineInterface.question(
        "Press Enter after enabling Identity Center in the Console...",
      );
      const retryResponse = await props.input.ssoAdminClient.send(new ListInstancesCommand({}));
      if ((retryResponse.Instances ?? []).length > 0) {
        props.input.logger.log("IAM Identity Center: detected");
        return;
      }
      props.input.logger.log(
        "Identity Center not yet detected. Please ensure it is enabled and try again.",
      );
    }
  } finally {
    readlineInterface.close();
  }
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
    const getFunction = await props.lambdaClient.send(
      new GetFunctionCommand({ FunctionName: lambdaFunctionName }),
    );
    const existingArn = getFunction.Configuration?.FunctionArn ?? "";
    if (existingArn === "") {
      throw new Error("Lambda function exists but ARN is empty.");
    }

    await waitForLambdaReady(props.lambdaClient, lambdaFunctionName);

    await props.lambdaClient.send(
      new UpdateFunctionCodeCommand({
        FunctionName: lambdaFunctionName,
        ZipFile: props.lambdaZip,
      }),
    );

    await waitForLambdaReady(props.lambdaClient, lambdaFunctionName);

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

    await props.lambdaClient.send(
      new TagResourceCommand({
        Resource: existingArn,
        Tags: Object.fromEntries(getStandardTags("remote-execution").map((t) => [t.Key, t.Value])),
      }),
    );

    props.logger.log(`Updated Lambda function code: ${lambdaFunctionName}`);

    try {
      await props.lambdaClient.send(
        new PutFunctionConcurrencyCommand({
          FunctionName: lambdaFunctionName,
          ReservedConcurrentExecutions: 1,
        }),
      );
      props.logger.log(`Reserved concurrency set to 1.`);
    } catch (concurrencyError: unknown) {
      if ((concurrencyError as { name?: string }).name !== "InvalidParameterValueException") {
        throw concurrencyError;
      }
      props.logger.log(
        "Reserved concurrency not set (account quota too low). Run 'upgrade' after quota is raised.",
      );
      props.logger.log(
        "  https://console.aws.amazon.com/servicequotas/home/services/lambda/quotas/L-B99A9384",
      );
    }

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

      try {
        await props.lambdaClient.send(
          new PutFunctionConcurrencyCommand({
            FunctionName: lambdaFunctionName,
            ReservedConcurrentExecutions: 1,
          }),
        );
        props.logger.log(`Set reserved concurrency to 1`);
      } catch (concurrencyError: unknown) {
        if ((concurrencyError as { name?: string }).name === "InvalidParameterValueException") {
          props.logger.log(
            "Could not set reserved concurrency (account concurrency quota too low for new accounts).",
          );
          props.logger.log(
            "AWS will automatically raise your quota over time, or request an increase:",
          );
          props.logger.log(
            "  https://console.aws.amazon.com/servicequotas/home/services/lambda/quotas/L-B99A9384",
          );
          props.logger.log("Run 'upgrade' after quota is raised to apply reserved concurrency.");
        } else {
          throw concurrencyError;
        }
      }

      props.logger.log(`Created Lambda function: ${lambdaFunctionName}`);
      return lambdaArn;
    }
    throw error;
  }
}

const iamPropagationMaxAttempts = 10;
const iamPropagationRetryIntervalMs = 2_000;

async function createLambdaFunctionWithRetry(props: {
  lambdaClient: LambdaClient;
  roleArn: string;
  lambdaZip: Buffer;
  bucketName: string;
  lambdaMemoryMb?: number;
  lambdaTimeoutSeconds?: number;
  logger: Logger;
}): Promise<string> {
  for (let attempt = 1; attempt <= iamPropagationMaxAttempts; attempt++) {
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
      if (!isRoleNotReady || attempt === iamPropagationMaxAttempts) {
        throw error;
      }
      props.logger.log(
        `Waiting for IAM role to propagate (attempt ${attempt}/${iamPropagationMaxAttempts})...`,
      );
      await delay(iamPropagationRetryIntervalMs);
    }
  }
  throw new Error("Unreachable: retry loop exhausted without throwing.");
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
  tags: Array<AwsTag>;
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
  tags: Array<AwsTag>;
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
  tags: Array<AwsTag>;
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
