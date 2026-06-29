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
import {
  DescribeOrganizationCommand,
  type OrganizationsClient,
} from "@aws-sdk/client-organizations";
import {
  CreateBucketCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import { AssumeRoleCommand, type STSClient } from "@aws-sdk/client-sts";
import * as v from "valibot";

import { getErrorName } from "../helpers.js";
import type { LambdaResponsePayload } from "../lambdaSchemas.js";

type LambdaResponse = LambdaResponsePayload;

export async function createConfigDeliveryBucket(props: {
  targetAccountId: string;
  bucketName: string;
  region: string;
  organizationsClient: OrganizationsClient;
  managedByTag: {
    Key: string;
    Value: string;
  };
  stsClient: STSClient;
}): Promise<LambdaResponse> {
  const orgResponse = await props.organizationsClient.send(new DescribeOrganizationCommand({}));
  const organizationId = orgResponse.Organization?.Id;
  if (organizationId == null) {
    throw new Error("Could not determine organization ID.");
  }

  const credentials = await assumeRoleIntoAccount({
    stsClient: props.stsClient,
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
    managedByTag: props.managedByTag,
  });

  return {
    action: "createConfigDeliveryBucket" as const,
    success: true,
    bucketName: props.bucketName,
    created,
  };
}

export async function createConfigAggregator(props: {
  targetAccountId: string;
  region: string;
  stsClient: STSClient;
}): Promise<LambdaResponse> {
  const credentials = await assumeRoleIntoAccount({
    targetAccountId: props.targetAccountId,
    sessionName: "beesolve-aws-accounts-config-aggregator",
    stsClient: props.stsClient,
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

export async function createCloudTrailBucket(props: {
  targetAccountId: string;
  bucketName: string;
  region: string;
  organizationId: string;
  managedByTag: {
    Key: string;
    Value: string;
  };
  stsClient: STSClient;
}): Promise<LambdaResponse> {
  const credentials = await assumeRoleIntoAccount({
    targetAccountId: props.targetAccountId,
    sessionName: "beesolve-aws-accounts-cloudtrail-bucket",
    stsClient: props.stsClient,
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
    managedByTag: props.managedByTag,
  });

  return {
    action: "createCloudTrailBucket" as const,
    success: true,
    bucketName: props.bucketName,
    created,
  };
}

export async function createOrgTrail(props: {
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
    if (getErrorName(error) !== "TrailNotFoundException") {
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

async function createManagedBucket(props: {
  s3Client: S3Client;
  bucketName: string;
  region: string;
  purposeTag: string;
  policy: string;
  managedByTag: {
    Key: string;
    Value: string;
  };
}): Promise<boolean> {
  let created = false;
  try {
    await props.s3Client.send(
      new CreateBucketCommand({
        Bucket: props.bucketName,
        ...(props.region !== "us-east-1" && {
          CreateBucketConfiguration: {
            LocationConstraint: props.region as BucketLocationConstraint,
          },
        }),
      }),
    );
    created = true;
  } catch (error: unknown) {
    const name = getErrorName(error);
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
      Tagging: { TagSet: [props.managedByTag, { Key: "Purpose", Value: props.purposeTag }] },
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

const assumedCredentialsSchema = v.strictObject({
  AccessKeyId: v.string(),
  SecretAccessKey: v.string(),
  SessionToken: v.string(),
});

async function assumeRoleIntoAccount(props: {
  stsClient: STSClient;
  targetAccountId: string;
  sessionName: string;
}): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  const assumeResult = await props.stsClient.send(
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
