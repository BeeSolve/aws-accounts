export function toPolicies<T extends string, A extends string>() {
  return {
    scp: {
      blockExpensiveResources: blockExpensiveResources<T, A>,
      protectSecurityServices: protectSecurityServices<T, A>,
      denyRootWithoutMfa: denyRootWithoutMfa<T>,
    },
    backupPolicy: {
      dailyWithRetention: dailyWithRetention<T>,
    },
    permissionSet: {
      readOnlyAuditor,
      cloudTrailAnalyst,
      configCompliance,
      securityInvestigator,
    },
  };
}

type BlockExpensiveResourcesOptions<T extends string, A extends string> = {
  exemptAccounts?: A[];
  allowedEc2InstanceTypes: string[];
  targets?: T[];
  name?: string;
};

type PolicyEntry<T extends string> = {
  name: string;
  description: string;
  content: Record<string, unknown>;
  targets: T[];
};

function blockExpensiveResources<T extends string, A extends string>(
  options: BlockExpensiveResourcesOptions<T, A>,
): PolicyEntry<T> {
  const exempt = options.exemptAccounts ?? [];
  const condition = toExtemptAccountsCondition(exempt);
  const statements: Record<string, unknown>[] = [
    {
      Sid: "DenyBedrock",
      Effect: "Deny",
      Action: "bedrock:*",
      Resource: "*",
      ...(condition && { Condition: condition }),
    },
    {
      Sid: "DenyNonAllowedEC2",
      Effect: "Deny",
      Action: "ec2:RunInstances",
      Resource: "arn:aws:ec2:*:*:instance/*",
      Condition: {
        ...condition,
        "ForAnyValue:StringNotLike": { "ec2:InstanceType": options.allowedEc2InstanceTypes },
      },
    },
    {
      Sid: "DenyExpensiveCompute",
      Effect: "Deny",
      Action: [
        "sagemaker:CreateNotebookInstance",
        "sagemaker:CreateTrainingJob",
        "sagemaker:CreateEndpoint",
        "sagemaker:CreateProcessingJob",
        "ecs:RunTask",
        "ecs:CreateService",
        "eks:CreateNodegroup",
        "lightsail:CreateInstances",
        "apprunner:CreateService",
      ],
      Resource: "*",
      ...(condition && { Condition: condition }),
    },
    {
      Sid: "DenyExpensivePurchases",
      Effect: "Deny",
      Action: [
        "ec2:PurchaseReservedInstancesOffering",
        "ec2:PurchaseHostReservation",
        "ec2:PurchaseCapacityBlock",
        "ec2:PurchaseScheduledInstances",
        "rds:PurchaseReservedDBInstancesOffering",
        "redshift:PurchaseReservedNodeOffering",
        "elasticache:PurchaseReservedCacheNodesOffering",
        "es:PurchaseReservedInstanceOffering",
        "savingsplans:CreateSavingsPlan",
        "aws-marketplace:Subscribe",
        "aws-marketplace:AcceptAgreementApprovalRequest",
        "shield:CreateSubscription",
        "route53domains:RegisterDomain",
        "route53domains:TransferDomain",
        "acm-pca:CreateCertificateAuthority",
        "glacier:InitiateVaultLock",
        "glacier:CompleteVaultLock",
        "s3:PutObjectLegalHold",
        "s3:PutObjectRetention",
        "s3:PutBucketObjectLockConfiguration",
        "snowball:CreateCluster",
      ],
      Resource: "*",
      ...(condition && { Condition: condition }),
    },
  ];
  return {
    name: options.name ?? "BlockExpensiveResources",
    description:
      "Prevents expensive resource creation (GPU/accelerator instances, Bedrock, SageMaker, ECS, and expensive purchases). Exempt accounts by adding their IDs to exemptAccounts.",
    content: { Version: "2012-10-17", Statement: statements },
    targets: options.targets ?? (["root"] as T[]),
  };
}

type ProtectSecurityServicesOptions<T extends string, A extends string> = {
  exemptAccounts?: A[];
  targets?: T[];
  name?: string;
};

function protectSecurityServices<T extends string, A extends string>(
  options: ProtectSecurityServicesOptions<T, A> = {},
): PolicyEntry<T> {
  const exempt = options.exemptAccounts ?? [];
  const condition = toExtemptAccountsCondition(exempt);
  const statements: Record<string, unknown>[] = [
    {
      Sid: "ProtectCloudTrail",
      Effect: "Deny",
      Action: [
        "cloudtrail:DeleteTrail",
        "cloudtrail:StopLogging",
        "cloudtrail:UpdateTrail",
        "cloudtrail:PutEventSelectors",
      ],
      Resource: "*",
      ...(condition && { Condition: condition }),
    },
    {
      Sid: "ProtectConfig",
      Effect: "Deny",
      Action: [
        "config:DeleteConfigurationRecorder",
        "config:DeleteDeliveryChannel",
        "config:DeleteRetentionConfiguration",
        "config:StopConfigurationRecorder",
      ],
      Resource: "*",
      ...(condition && { Condition: condition }),
    },
    {
      Sid: "ProtectGuardDuty",
      Effect: "Deny",
      Action: [
        "guardduty:DeleteDetector",
        "guardduty:DeleteMembers",
        "guardduty:DisassociateFromMasterAccount",
        "guardduty:DisassociateMembers",
      ],
      Resource: "*",
      ...(condition && { Condition: condition }),
    },
  ];
  return {
    name: options.name ?? "ProtectSecurityServices",
    description: "Prevents member accounts from disabling CloudTrail, AWS Config, and GuardDuty.",
    content: { Version: "2012-10-17", Statement: statements },
    targets: options.targets ?? (["root"] as T[]),
  };
}

type DenyRootWithoutMfaOptions<T extends string> = {
  targets?: T[];
  name?: string;
};

function denyRootWithoutMfa<T extends string>(
  options: DenyRootWithoutMfaOptions<T> = {},
): PolicyEntry<T> {
  return {
    name: options.name ?? "DenyRootWithoutMFA",
    description: "Denies all actions by the root user unless MFA is present.",
    content: {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "DenyRootWithoutMFA",
          Effect: "Deny",
          Action: "*",
          Resource: "*",
          Condition: {
            StringLike: { "aws:PrincipalArn": "arn:aws:iam::*:root" },
            BoolIfExists: { "aws:MultiFactorAuthPresent": "false" },
          },
        },
      ],
    },
    targets: options.targets ?? (["root"] as T[]),
  };
}

type DailyBackupPolicyOptions<T extends string> = {
  retentionDays?: number;
  regions: string[];
  backupVaultName?: string;
  iamRoleName?: string;
  targets?: T[];
  name?: string;
};

function dailyWithRetention<T extends string>(
  options: DailyBackupPolicyOptions<T>,
): PolicyEntry<T> {
  const retention = options.retentionDays ?? 35;
  const vault = options.backupVaultName ?? "Default";
  const role = options.iamRoleName ?? "AWSBackupDefaultServiceRole";
  return {
    name: options.name ?? "DailyBackupPolicy",
    description: `Daily backup of EBS, RDS, DynamoDB, EFS, and S3 with ${retention}-day retention.`,
    content: {
      plans: {
        DailyBackup: {
          regions: { "@@assign": options.regions },
          rules: {
            Daily: {
              schedule_expression: { "@@assign": "cron(0 5 ? * * *)" },
              start_backup_window_minutes: { "@@assign": "60" },
              complete_backup_window_minutes: { "@@assign": "1440" },
              target_backup_vault_name: { "@@assign": vault },
              lifecycle: { delete_after_days: { "@@assign": String(retention) } },
            },
          },
          selections: {
            resources: {
              StandardResources: {
                iam_role_arn: { "@@assign": `arn:aws:iam::$account:role/${role}` },
                resource_types: {
                  "@@assign": [
                    "arn:aws:ec2:*:*:volume/*",
                    "arn:aws:rds:*:*:db:*",
                    "arn:aws:dynamodb:*:*:table/*",
                    "arn:aws:elasticfilesystem:*:*:file-system/*",
                    "arn:aws:s3:::*",
                  ],
                },
              },
            },
          },
        },
      },
    },
    targets: options.targets ?? (["root"] as T[]),
  };
}

type PermissionSetOptions = {
  sessionDuration?: string;
  name?: string;
};

type PermissionSetEntry = {
  name: string;
  description: string;
  sessionDuration?: string;
  inlinePolicy?: Record<string, unknown>;
  awsManagedPolicies: string[];
  customerManagedPolicies: { name: string; path: string }[];
};

function readOnlyAuditor(options: PermissionSetOptions = {}): PermissionSetEntry {
  return {
    name: options.name ?? "ReadOnlyAuditor",
    description: "Read-only access across all AWS services for security auditing.",
    sessionDuration: options.sessionDuration ?? "PT4H",
    awsManagedPolicies: ["arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"],
    customerManagedPolicies: [],
  };
}

function cloudTrailAnalyst(options: PermissionSetOptions = {}): PermissionSetEntry {
  return {
    name: options.name ?? "CloudTrailAnalyst",
    description: "CloudTrail log access with Athena query capabilities for security investigation.",
    sessionDuration: options.sessionDuration ?? "PT4H",
    inlinePolicy: {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "CloudTrailRead",
          Effect: "Allow",
          Action: [
            "cloudtrail:LookupEvents",
            "cloudtrail:GetTrail",
            "cloudtrail:GetTrailStatus",
            "cloudtrail:ListTrails",
            "cloudtrail:DescribeTrails",
            "cloudtrail:GetEventSelectors",
          ],
          Resource: "*",
        },
        {
          Sid: "S3LogAccess",
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"],
          Resource: [
            "arn:aws:s3:::aws-cloudtrail-logs-*",
            "arn:aws:s3:::aws-cloudtrail-logs-*/*",
            "arn:aws:s3:::aws-controltower-logs-*",
            "arn:aws:s3:::aws-controltower-logs-*/*",
          ],
        },
        {
          Sid: "AthenaQuery",
          Effect: "Allow",
          Action: [
            "athena:StartQueryExecution",
            "athena:GetQueryExecution",
            "athena:GetQueryResults",
            "athena:GetWorkGroup",
            "athena:ListWorkGroups",
            "glue:GetDatabase",
            "glue:GetDatabases",
            "glue:GetTable",
            "glue:GetTables",
            "glue:GetPartitions",
          ],
          Resource: "*",
        },
        {
          Sid: "AthenaResultsBucket",
          Effect: "Allow",
          Action: ["s3:PutObject", "s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"],
          Resource: [
            "arn:aws:s3:::aws-athena-query-results-*",
            "arn:aws:s3:::aws-athena-query-results-*/*",
          ],
        },
      ],
    },
    awsManagedPolicies: [],
    customerManagedPolicies: [],
  };
}

function configCompliance(options: PermissionSetOptions = {}): PermissionSetEntry {
  return {
    name: options.name ?? "ConfigCompliance",
    description: "AWS Config read access for compliance monitoring and resource inventory.",
    sessionDuration: options.sessionDuration ?? "PT4H",
    inlinePolicy: {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "ConfigRead",
          Effect: "Allow",
          Action: [
            "config:Describe*",
            "config:Get*",
            "config:List*",
            "config:BatchGetResourceConfig",
            "config:SelectResourceConfig",
          ],
          Resource: "*",
        },
        {
          Sid: "TagRead",
          Effect: "Allow",
          Action: ["tag:GetResources", "tag:GetTagKeys", "tag:GetTagValues"],
          Resource: "*",
        },
      ],
    },
    awsManagedPolicies: [],
    customerManagedPolicies: [],
  };
}

function securityInvestigator(options: PermissionSetOptions = {}): PermissionSetEntry {
  return {
    name: options.name ?? "SecurityInvestigator",
    description:
      "Combined read access to CloudTrail, Config, GuardDuty, and Security Hub for security investigations.",
    sessionDuration: options.sessionDuration ?? "PT8H",
    inlinePolicy: {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "CloudTrailRead",
          Effect: "Allow",
          Action: [
            "cloudtrail:LookupEvents",
            "cloudtrail:Get*",
            "cloudtrail:List*",
            "cloudtrail:Describe*",
          ],
          Resource: "*",
        },
        {
          Sid: "ConfigRead",
          Effect: "Allow",
          Action: [
            "config:Describe*",
            "config:Get*",
            "config:List*",
            "config:BatchGetResourceConfig",
          ],
          Resource: "*",
        },
        {
          Sid: "GuardDutyRead",
          Effect: "Allow",
          Action: ["guardduty:Get*", "guardduty:List*"],
          Resource: "*",
        },
        {
          Sid: "SecurityHubRead",
          Effect: "Allow",
          Action: [
            "securityhub:Get*",
            "securityhub:List*",
            "securityhub:Describe*",
            "securityhub:BatchGetFindings",
          ],
          Resource: "*",
        },
        {
          Sid: "IAMRead",
          Effect: "Allow",
          Action: ["iam:Get*", "iam:List*", "sts:GetCallerIdentity"],
          Resource: "*",
        },
      ],
    },
    awsManagedPolicies: [],
    customerManagedPolicies: [],
  };
}

function toExtemptAccountsCondition(exemptAccounts: string[]): Record<string, unknown> | undefined {
  if (exemptAccounts.length === 0) return undefined;
  return { StringNotEquals: { "aws:PrincipalAccount": exemptAccounts } };
}

type SecurityBaselineOptions<T extends string, A extends string> = {
  cloudTrail?: {
    enabled: boolean;
    delegatedAdminAccount: A;
    logArchiveAccount: A;
  };
  configRecorder?: {
    enabled: boolean;
    delegatedAdminAccount: A;
    deliveryBucketAccount: A;
    targets: T[];
    recordAllResourceTypes?: boolean;
    includeGlobalResources?: boolean;
    deliveryFrequency?: "One_Hour" | "Three_Hours" | "Six_Hours" | "Twelve_Hours" | "TwentyFour_Hours";
  };
  guardDuty?: {
    enabled: boolean;
    delegatedAdminAccount: A;
    targets?: T[];
    findingPublishingFrequency?: "FIFTEEN_MINUTES" | "ONE_HOUR" | "SIX_HOURS";
  };
  rootAccessManagement?: {
    enabled: boolean;
    delegatedAdminAccount?: A;
  };
};

type StackSetDeclaration = {
  name: string;
  templateKey: string;
  targets: string[];
  parameters: Array<{ key: string; value: string }>;
};

type SecurityBaselineExtension = {
  securityBaseline?: {
    stackSets: StackSetDeclaration[];
  };
};

export function withSecurityBaseline<
  C extends { organizationalUnits: Array<{ accounts: Array<{ name: string }> }>; delegatedAdministrators: Array<{ account: string; servicePrincipal: string }> },
  T extends string,
  A extends string,
>(config: C, options: SecurityBaselineOptions<T, A>): C & SecurityBaselineExtension {
  const allAccountNames = config.organizationalUnits.flatMap((ou) =>
    ou.accounts.map((a) => a.name),
  );

  function assertAccountExists(name: string): void {
    if (!allAccountNames.includes(name)) {
      throw new Error(
        `withSecurityBaseline: account "${name}" not found in organizationalUnits. Define it in your config first.`,
      );
    }
  }

  const delegatedAdmins = [...config.delegatedAdministrators];
  const stackSets: StackSetDeclaration[] = [];

  if (options.cloudTrail?.enabled) {
    assertAccountExists(options.cloudTrail.delegatedAdminAccount);
    assertAccountExists(options.cloudTrail.logArchiveAccount);
    if (!delegatedAdmins.some((d) => d.account === options.cloudTrail!.delegatedAdminAccount && d.servicePrincipal === "cloudtrail.amazonaws.com")) {
      delegatedAdmins.push({ account: options.cloudTrail.delegatedAdminAccount, servicePrincipal: "cloudtrail.amazonaws.com" });
    }
  }

  if (options.configRecorder?.enabled) {
    assertAccountExists(options.configRecorder.delegatedAdminAccount);
    assertAccountExists(options.configRecorder.deliveryBucketAccount);
    if (!delegatedAdmins.some((d) => d.account === options.configRecorder!.delegatedAdminAccount && d.servicePrincipal === "config.amazonaws.com")) {
      delegatedAdmins.push({ account: options.configRecorder.delegatedAdminAccount, servicePrincipal: "config.amazonaws.com" });
    }
    stackSets.push({
      name: "SecurityBaseline-ConfigRecorder",
      templateKey: "config-recorder",
      targets: options.configRecorder.targets as string[],
      parameters: [
        { key: "AllSupported", value: String(options.configRecorder.recordAllResourceTypes ?? true) },
        { key: "IncludeGlobalResourceTypes", value: String(options.configRecorder.includeGlobalResources ?? true) },
        { key: "DeliveryFrequency", value: options.configRecorder.deliveryFrequency ?? "TwentyFour_Hours" },
      ],
    });
  }

  if (options.guardDuty?.enabled) {
    assertAccountExists(options.guardDuty.delegatedAdminAccount);
    if (!delegatedAdmins.some((d) => d.account === options.guardDuty!.delegatedAdminAccount && d.servicePrincipal === "guardduty.amazonaws.com")) {
      delegatedAdmins.push({ account: options.guardDuty.delegatedAdminAccount, servicePrincipal: "guardduty.amazonaws.com" });
    }
    stackSets.push({
      name: "SecurityBaseline-GuardDuty",
      templateKey: "guardduty-member",
      targets: (options.guardDuty.targets ?? ["root"]) as string[],
      parameters: [
        { key: "FindingPublishingFrequency", value: options.guardDuty.findingPublishingFrequency ?? "FIFTEEN_MINUTES" },
      ],
    });
  }

  if (options.rootAccessManagement?.enabled) {
    if (options.rootAccessManagement.delegatedAdminAccount != null) {
      assertAccountExists(options.rootAccessManagement.delegatedAdminAccount);
      if (!delegatedAdmins.some((d) => d.account === options.rootAccessManagement!.delegatedAdminAccount && d.servicePrincipal === "iam.amazonaws.com")) {
        delegatedAdmins.push({ account: options.rootAccessManagement.delegatedAdminAccount, servicePrincipal: "iam.amazonaws.com" });
      }
    }
  }

  return {
    ...config,
    delegatedAdministrators: delegatedAdmins,
    ...(stackSets.length > 0 && {
      securityBaseline: { stackSets },
    }),
  };
}
