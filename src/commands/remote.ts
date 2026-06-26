import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DeleteRetentionPolicyCommand,
  DescribeLogGroupsCommand,
  TagResourceCommand as LogsTagResourceCommand,
  PutRetentionPolicyCommand,
  ResourceAlreadyExistsException,
} from "@aws-sdk/client-cloudwatch-logs";
import type { IAMClient } from "@aws-sdk/client-iam";
import { PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { GetFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { OrganizationsClient } from "@aws-sdk/client-organizations";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import type { STSClient } from "@aws-sdk/client-sts";
import { account, identitystore, logs, organizations, s3, sso } from "@beesolve/iam-policy-ts";
import * as v from "valibot";

import { buildAwsClientConfig } from "../awsClientConfig.js";
import type { AwsConfigModel, AwsContextFile, Deployment } from "../awsConfig.js";
import { readAwsContextFromFile } from "../awsConfig.js";
import { toPreconditionError } from "../error.js";
import { assertUnreachable, delay, startProgressTimer } from "../helpers.js";
import { invokeLambda } from "../lambdaClient.js";
import type { Logger } from "../logger.js";
import type { Operation, Plan, StackSetOperation } from "../operations.js";
import { isCacheFresh, readStateCache, writeStateCache } from "../remoteStateCache.js";
import { validateState, type StateFile } from "../state.js";
import { getStandardTags } from "../tags.js";

const remoteCommandSchema = v.object({
  subcommand: v.picklist(["bootstrap", "scan", "init", "plan", "apply", "upgrade", "drift"]),
  profile: v.optional(v.string()),
  region: v.optional(v.string()),
  flags: v.object({
    yes: v.boolean(),
    refresh: v.boolean(),
    allowDestructive: v.boolean(),
    ignoreUnsupported: v.boolean(),
    redeployStacksets: v.boolean(),
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
  organizationsClient: OrganizationsClient;
};

export const contextFilePath = "aws.context.json";
export const configFilePath = "aws.config.ts";
export const typesFilePath = "aws.config.types.ts";
export const cachePath = ".remote-state-cache.json";
export const lambdaRoleName = "beesolve-aws-accounts-lambda-role";
export const lambdaFunctionName = "beesolve-aws-accounts";
export const lambdaLogGroupName = `/aws/lambda/${lambdaFunctionName}`;

export { runRemoteBootstrap } from "./remoteBootstrap.js";
export { runRemoteDrift } from "./remoteDrift.js";
export { runRemoteInit } from "./remoteInit.js";
export { runRemoteApply, runRemotePlan } from "./remotePlanApply.js";
export { runRemoteScan } from "./remoteScan.js";
export { runRemoteUpgrade } from "./remoteUpgrade.js";

export async function readDeploymentFromContext(): Promise<Deployment> {
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

export async function fetchCurrentState(props: {
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

export function displayPlan(props: {
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

export function isDestructiveOperation(operation: Operation): boolean {
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

export function formatLambdaError(error: { kind: string; [key: string]: unknown }): string {
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

export async function checkPendingStackSetOperations(props: {
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

export async function applyLambdaRolePolicy(props: {
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
      {
        Effect: "Allow",
        Action: [
          "cloudtrail:CreateTrail",
          "cloudtrail:UpdateTrail",
          "cloudtrail:StartLogging",
          "cloudtrail:GetTrail",
          "cloudtrail:GetTrailStatus",
        ],
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
}

export function warnIfRemotePoliciesNotInConfig(props: {
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
    props.logger.log("Run drift to check for differences first.");
    props.logger.log("");
  }
}

export async function ensureLogGroup(props: {
  region: string;
  profile: string;
  retentionDays: number | undefined;
  logger: Logger;
}): Promise<void> {
  const logsClient = new CloudWatchLogsClient(
    buildAwsClientConfig({ profile: props.profile, region: props.region }),
  );
  try {
    await logsClient.send(new CreateLogGroupCommand({ logGroupName: lambdaLogGroupName }));
    props.logger.log(`Created log group: ${lambdaLogGroupName}`);
  } catch (error: unknown) {
    if (!(error instanceof ResourceAlreadyExistsException)) throw error;
  }
  const describeResult = await logsClient.send(
    new DescribeLogGroupsCommand({ logGroupNamePrefix: lambdaLogGroupName, limit: 1 }),
  );
  const logGroupArn = describeResult.logGroups?.[0]?.arn;
  if (logGroupArn != null) {
    await logsClient.send(
      new LogsTagResourceCommand({
        resourceArn: logGroupArn,
        tags: Object.fromEntries(getStandardTags("lambda-logs").map((t) => [t.Key, t.Value])),
      }),
    );
  }
  if (props.retentionDays != null) {
    await logsClient.send(
      new PutRetentionPolicyCommand({
        logGroupName: lambdaLogGroupName,
        retentionInDays: props.retentionDays,
      }),
    );
  } else {
    await logsClient.send(new DeleteRetentionPolicyCommand({ logGroupName: lambdaLogGroupName }));
  }
}

export async function readLambdaZip(): Promise<Buffer> {
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

export async function waitForLambdaReady(
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

const validStackSetNames = new Set(["security-setup", "config-recorder", "guardduty-member"]);

export function computeStackSetOperations(
  config: AwsConfigModel,
  context: {
    managementAccountId: string;
    organizationId: string | undefined;
    region: string;
    ouIdsByName: Record<string, string>;
    deployedStackSets?: Array<{ name: string; targets: string[] }>;
    forceRedeploy?: boolean;
  },
): StackSetOperation[] | undefined {
  const baseline = config.securityBaseline;
  if (baseline == null || baseline.stackSets.length === 0) return undefined;
  if (!context.organizationId) {
    throw new Error("Organization ID not found in context. Run 'scan' to populate it.");
  }
  const deliveryBucketName = `config-delivery-${context.organizationId}-${context.region}`;
  const deployed = context.forceRedeploy ? [] : (context.deployedStackSets ?? []);
  return baseline.stackSets.flatMap((ss) => {
    if (!validStackSetNames.has(ss.templateKey)) return [];
    const resolvedTargets = ss.targets.map((t) => {
      const id = context.ouIdsByName[t];
      if (!id) throw new Error(`Cannot resolve OU name "${t}" to an ID. Run 'scan' first.`);
      return id;
    });
    const existing = deployed.find((d) => d.name === ss.templateKey);
    if (
      existing &&
      JSON.stringify(existing.targets.sort()) === JSON.stringify(resolvedTargets.sort())
    ) {
      return [];
    }
    return [
      {
        action: "create" as const,
        stackSetName: ss.templateKey as "security-setup" | "config-recorder" | "guardduty-member",
        targets: resolvedTargets,
        parameters: ss.parameters.map((p) => ({
          key: p.key,
          value:
            p.value === "{{MANAGEMENT_ACCOUNT_ID}}"
              ? context.managementAccountId
              : p.value === "{{DELIVERY_BUCKET_NAME}}"
                ? deliveryBucketName
                : p.value === "{{CLOUDTRAIL_BUCKET_NAME}}"
                  ? `cloudtrail-logs-${context.organizationId}-${context.region}`
                  : p.value,
        })),
        regions: [context.region],
        ...(ss.templateKey === "security-setup" && { waitForCompletion: true }),
      },
    ];
  });
}

export async function executeStackSetOperations(props: {
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
