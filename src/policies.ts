type ScpPolicyEntry = {
  name: string;
  description: string;
  content: Record<string, unknown>;
  targets: string[];
};

type BlockExpensiveResourcesOptions = {
  /**
   * Account IDs exempt from all restrictions.
   * @default [] (no exemptions)
   */
  exemptAccounts?: string[];
  /**
   * EC2 instance types allowed for RunInstances. Everything else is denied.
   */
  allowedEc2InstanceTypes: string[];
  /**
   * OU/account names to attach this SCP to.
   * @default ["root"]
   */
  targets?: string[];
  /**
   * Override policy name.
   * @default "BlockExpensiveResources"
   */
  name?: string;
};

function buildCondition(exemptAccounts: string[]): Record<string, unknown> | undefined {
  if (exemptAccounts.length === 0) return undefined;
  return { StringNotEquals: { "aws:PrincipalAccount": exemptAccounts } };
}

function blockExpensiveResources(options: BlockExpensiveResourcesOptions): ScpPolicyEntry {
  const exempt = options.exemptAccounts ?? [];
  const condition = buildCondition(exempt);

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
        "ForAnyValue:StringNotLike": {
          "ec2:InstanceType": options.allowedEc2InstanceTypes,
        },
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
    targets: options.targets ?? ["root"],
  };
}

export const scp = { blockExpensiveResources } as const;
