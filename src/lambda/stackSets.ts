import {
  type CloudFormationClient,
  CreateStackInstancesCommand,
  CreateStackSetCommand,
  DescribeStackSetCommand,
  DescribeStackSetOperationCommand,
  UpdateStackSetCommand,
} from "@aws-sdk/client-cloudformation";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { getErrorName } from "../helpers.ts";
import type { LambdaResponsePayload } from "../lambdaSchemas.ts";
import { readStateFromS3, writeStateToS3 } from "./state.ts";

type LambdaResponse = LambdaResponsePayload;

const uploadUrlExpirySeconds = 60;

export async function getUploadUrl(props: {
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

export async function deployStackSet(props: {
  s3Client: S3Client;
  cloudFormationClient: CloudFormationClient;
  bucket: string;
  stackSetName: string;
  targets: Array<string>;
  parameters: Array<{ key: string; value: string }>;
  regions: Array<string>;
  waitForCompletion: boolean;
  managedByTag: {
    Key: string;
    Value: string;
  };
}): Promise<LambdaResponse> {
  const templateObj = await props.s3Client.send(
    new GetObjectCommand({ Bucket: props.bucket, Key: toTemplateS3Key(props.stackSetName) }),
  );
  const templateBody = await templateObj.Body?.transformToString();
  if (templateBody == null) {
    throw new Error(`Template not found in S3 for stack set "${props.stackSetName}".`);
  }

  const cfnParams = props.parameters.map(({ key, value }) => ({
    ParameterKey: key,
    ParameterValue: value,
  }));

  const { stackSetId, operationId } = await deployOrUpdateStackSet({
    cloudFormationClient: props.cloudFormationClient,
    stackSetName: props.stackSetName,
    templateBody,
    cfnParams,
    targets: props.targets,
    regions: props.regions,
    managedByTag: props.managedByTag,
  });

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

type DeployOrUpdateResult = { stackSetId: string; operationId: string };

async function deployOrUpdateStackSet(props: {
  cloudFormationClient: CloudFormationClient;
  stackSetName: string;
  templateBody: string;
  cfnParams: Array<{ ParameterKey: string; ParameterValue: string }>;
  targets: Array<string>;
  regions: Array<string>;
  managedByTag: { Key: string; Value: string };
}): Promise<DeployOrUpdateResult> {
  try {
    await props.cloudFormationClient.send(
      new DescribeStackSetCommand({ StackSetName: props.stackSetName }),
    );
  } catch (error: unknown) {
    if (getErrorName(error) === "StackSetNotFoundException") {
      return createNewStackSet(props);
    }
    throw error;
  }
  return updateExistingStackSet(props);
}

async function createNewStackSet(props: {
  cloudFormationClient: CloudFormationClient;
  stackSetName: string;
  templateBody: string;
  cfnParams: Array<{ ParameterKey: string; ParameterValue: string }>;
  targets: Array<string>;
  regions: Array<string>;
  managedByTag: { Key: string; Value: string };
}): Promise<DeployOrUpdateResult> {
  const createResult = await props.cloudFormationClient.send(
    new CreateStackSetCommand({
      StackSetName: props.stackSetName,
      TemplateBody: props.templateBody,
      Parameters: props.cfnParams,
      PermissionModel: "SERVICE_MANAGED",
      AutoDeployment: { Enabled: true, RetainStacksOnAccountRemoval: false },
      Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
      Tags: [props.managedByTag],
    }),
  );
  const stackSetId = createResult.StackSetId ?? props.stackSetName;
  const instanceResult = await props.cloudFormationClient.send(
    new CreateStackInstancesCommand({
      StackSetName: props.stackSetName,
      Regions: props.regions,
      DeploymentTargets: { OrganizationalUnitIds: props.targets },
    }),
  );
  const operationId = instanceResult.OperationId ?? "create-in-progress";
  return { stackSetId, operationId };
}

async function updateExistingStackSet(props: {
  cloudFormationClient: CloudFormationClient;
  stackSetName: string;
  templateBody: string;
  cfnParams: Array<{ ParameterKey: string; ParameterValue: string }>;
  targets: Array<string>;
  regions: Array<string>;
  managedByTag: { Key: string; Value: string };
}): Promise<DeployOrUpdateResult> {
  try {
    await props.cloudFormationClient.send(
      new UpdateStackSetCommand({
        StackSetName: props.stackSetName,
        TemplateBody: props.templateBody,
        Parameters: props.cfnParams,
        Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
      }),
    );
  } catch (updateError: unknown) {
    if (getErrorName(updateError) !== "OperationInProgressException") throw updateError;
  }
  const stackSetId = props.stackSetName;
  try {
    const instanceResult = await props.cloudFormationClient.send(
      new CreateStackInstancesCommand({
        StackSetName: props.stackSetName,
        Regions: props.regions,
        DeploymentTargets: { OrganizationalUnitIds: props.targets },
      }),
    );
    const operationId = instanceResult.OperationId ?? "update-in-progress";
    return { stackSetId, operationId };
  } catch (instanceError: unknown) {
    if (getErrorName(instanceError) !== "StackInstanceNotFoundException") {
      throw instanceError;
    }
    return { stackSetId, operationId: "instances-already-exist" };
  }
}

export async function checkPendingStackSets(props: {
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

export async function recordDeployedStackSets(props: {
  s3Client: S3Client;
  bucket: string;
  stackSets: Array<{ name: string; targets: Array<string> }>;
  pendingOperations?: Array<{ stackSetName: string; operationId: string; startedAt: string }>;
}): Promise<LambdaResponse> {
  const { state, etag } = await readStateFromS3({ bucket: props.bucket, s3Client: props.s3Client });

  await writeStateToS3({
    bucket: props.bucket,
    state: {
      ...state,
      deployedStackSets: props.stackSets,
      pendingStackSetOperations: props.pendingOperations?.length
        ? props.pendingOperations
        : undefined,
    },
    s3Client: props.s3Client,
    ifMatch: etag,
  });

  return { action: "recordDeployedStackSets" as const, success: true };
}

function toTemplateS3Key(stackSetName: string): string {
  return `stackset-templates/${stackSetName}.yaml`;
}
