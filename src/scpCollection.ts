/**
 * Reusable AWS Service Control Policy (SCP) collection.
 *
 * Based on the production-ready SCP examples by Towards the Cloud:
 * https://towardsthecloud.com/blog/aws-scp-examples
 *
 * @see https://towardsthecloud.com/blog/aws-scp-examples
 */

type PolicyEntry<T extends string> = {
  name: string;
  description: string;
  content: Record<string, unknown>;
  targets: Array<T>;
};

interface ScpCollection<T extends string, _A extends string> {
  foundation: {
    denyRootUser: (options?: DenyRootUserOptions<T>) => PolicyEntry<T>;
    denyUnsupportedRegions: (options: DenyUnsupportedRegionsOptions<T>) => PolicyEntry<T>;
    enforceS3BucketOwnerEnforced: (options?: BaseOptions<T>) => PolicyEntry<T>;
    preventLeavingOrganization: (options?: BaseOptions<T>) => PolicyEntry<T>;
    denyIamUserCreation: (options?: DenyIamUserCreationOptions<T>) => PolicyEntry<T>;
    preventDisablingEbsEncryption: (options?: BaseOptions<T>) => PolicyEntry<T>;
    protectPasswordPolicy: (options: ProtectPasswordPolicyOptions<T>) => PolicyEntry<T>;
    enforceDataPerimeter: (options: EnforceDataPerimeterOptions<T>) => PolicyEntry<T>;
  };
  security: {
    protectSecurityServicesComprehensive: (
      options: ExemptRolesRequiredOptions<T>,
    ) => PolicyEntry<T>;
    protectSecurityHubConfig: (options: ExemptRolesRequiredOptions<T>) => PolicyEntry<T>;
    restrictToSecurityOperations: (options?: BaseOptions<T>) => PolicyEntry<T>;
    enforceMfaForIam: (options?: EnforceMfaForIamOptions<T>) => PolicyEntry<T>;
  };
  production: {
    enforceEncryption: (options?: BaseOptions<T>) => PolicyEntry<T>;
    preventUnauthorizedTermination: (
      options: PreventUnauthorizedTerminationOptions<T>,
    ) => PolicyEntry<T>;
    protectTaggedStacks: (options: ProtectTaggedStacksOptions<T>) => PolicyEntry<T>;
    enforceImdsV2: (options?: BaseOptions<T>) => PolicyEntry<T>;
  };
  development: {
    preventExpensiveInstances: (options?: PreventExpensiveInstancesOptions<T>) => PolicyEntry<T>;
    blockReservedPurchases: (options?: BaseOptions<T>) => PolicyEntry<T>;
    preventExpensiveAiMl: (options?: BaseOptions<T>) => PolicyEntry<T>;
    enforceResourceTagging: (options?: EnforceResourceTaggingOptions<T>) => PolicyEntry<T>;
  };
  sandbox: {
    restrictToBasicServices: (options?: RestrictToBasicServicesOptions<T>) => PolicyEntry<T>;
    preventExternalSharing: (options?: BaseOptions<T>) => PolicyEntry<T>;
  };
  suspended: {
    completeLockdown: (options: CompleteLockdownOptions<T>) => PolicyEntry<T>;
  };
  infrastructure: {
    restrictToNetworking: (options?: BaseOptions<T>) => PolicyEntry<T>;
    protectVpcFlowLogs: (options?: ProtectVpcFlowLogsOptions<T>) => PolicyEntry<T>;
  };
  modern: {
    controlBedrockModels: (options?: ControlBedrockModelsOptions<T>) => PolicyEntry<T>;
    restrictQDeveloperIam: (options?: BaseOptions<T>) => PolicyEntry<T>;
    requireVpcForSageMaker: (options?: BaseOptions<T>) => PolicyEntry<T>;
  };
}

export interface BaseOptions<T extends string> {
  targets?: Array<T>;
  name?: string;
}

export interface ExemptRolesOptionalOptions<T extends string> extends BaseOptions<T> {
  exemptRoles?: Array<string>;
}

export interface ExemptRolesRequiredOptions<T extends string> extends BaseOptions<T> {
  exemptRoles: Array<string>;
}

export type DenyRootUserOptions<T extends string> = BaseOptions<T>;

export interface DenyUnsupportedRegionsOptions<T extends string> extends BaseOptions<T> {
  allowedRegions: Array<string>;
  exemptRoles?: Array<string>;
}

export interface DenyIamUserCreationOptions<T extends string> extends BaseOptions<T> {
  exemptRoles?: Array<string>;
}

export interface ProtectPasswordPolicyOptions<T extends string> extends BaseOptions<T> {
  exemptRoles: Array<string>;
}

export interface EnforceDataPerimeterOptions<T extends string> extends BaseOptions<T> {
  organizationId: string;
  exemptRoles?: Array<string>;
}

export interface EnforceMfaForIamOptions<T extends string> extends BaseOptions<T> {
  exemptRoles?: Array<string>;
}

export interface PreventUnauthorizedTerminationOptions<T extends string> extends BaseOptions<T> {
  approvedRoles: Array<string>;
}

export interface ProtectTaggedStacksOptions<T extends string> extends BaseOptions<T> {
  organizationTagValue: string;
  exemptRoles: Array<string>;
  tagKey?: string;
}

export interface PreventExpensiveInstancesOptions<T extends string> extends BaseOptions<T> {
  allowedEc2InstanceTypes?: Array<string>;
  allowedRdsInstanceClasses?: Array<string>;
  denyNatGateway?: boolean;
  denyIo2Volumes?: boolean;
}

export interface EnforceResourceTaggingOptions<T extends string> extends BaseOptions<T> {
  requiredTags?: Array<string>;
}

export interface RestrictToBasicServicesOptions<T extends string> extends BaseOptions<T> {
  allowedServices?: Array<string>;
  allowedInstanceTypes?: Array<string>;
}

export interface CompleteLockdownOptions<T extends string> extends BaseOptions<T> {
  exemptRoles: Array<string>;
}

export interface ProtectVpcFlowLogsOptions<T extends string> extends BaseOptions<T> {
  exemptRoles?: Array<string>;
}

export interface ControlBedrockModelsOptions<T extends string> extends BaseOptions<T> {
  deniedModelPatterns?: Array<string>;
}

export function toScpCollection<T extends string, A extends string>(): ScpCollection<T, A> {
  return {
    foundation: {
      denyRootUser: (options?: DenyRootUserOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "DenyRootUser";
        const targets = options?.targets ?? (["root"] as Array<T>);
        return {
          name,
          description: "Denies all actions by the root user across member accounts",
          content: buildPolicyDocument([
            {
              Sid: "DenyRootUser",
              Effect: "Deny",
              Action: "*",
              Resource: "*",
              Condition: {
                StringLike: {
                  "aws:PrincipalArn": "arn:aws:iam::*:root",
                },
              },
            },
          ]),
          targets,
        };
      },
      denyUnsupportedRegions: (options: DenyUnsupportedRegionsOptions<T>): PolicyEntry<T> => {
        if (options.allowedRegions.length === 0) {
          throw new Error(
            "denyUnsupportedRegions: allowedRegions must contain at least one region",
          );
        }

        const name = options.name ?? "DenyUnsupportedRegions";
        const targets = options.targets ?? (["root"] as Array<T>);

        const notActionList = [
          "a4b:*",
          "acm:*",
          "aws-marketplace-management:*",
          "aws-marketplace:*",
          "aws-portal:*",
          "budgets:*",
          "ce:*",
          "chime:*",
          "cloudfront:*",
          "config:*",
          "cur:*",
          "directconnect:*",
          "ec2:DescribeRegions",
          "ec2:DescribeTransitGateways",
          "ec2:DescribeVpnGateways",
          "fms:*",
          "globalaccelerator:*",
          "health:*",
          "iam:*",
          "importexport:*",
          "kms:*",
          "mobileanalytics:*",
          "networkmanager:*",
          "organizations:*",
          "pricing:*",
          "route53:*",
          "route53domains:*",
          "route53-recovery-cluster:*",
          "route53-recovery-control-config:*",
          "route53-recovery-readiness:*",
          "s3:GetBucketLocation",
          "s3:ListAllMyBuckets",
          "shield:*",
          "sts:*",
          "support:*",
          "trustedadvisor:*",
          "waf-regional:*",
          "waf:*",
          "wafv2:*",
          "wellarchitected:*",
        ];

        const condition: Record<string, Record<string, string | Array<string>>> = {
          StringNotEquals: {
            "aws:RequestedRegion": options.allowedRegions,
          },
        };

        const exemptRolesCondition = buildExemptRolesCondition(options.exemptRoles ?? []);
        if (exemptRolesCondition != null) {
          const stringNotLike = exemptRolesCondition.StringNotLike as Record<string, Array<string>>;
          condition.StringNotLike = stringNotLike;
        }

        return {
          name,
          description:
            "Denies access to AWS services in unsupported regions while allowing global services",
          content: buildPolicyDocument([
            {
              Sid: "DenyUnsupportedRegions",
              Effect: "Deny",
              NotAction: notActionList,
              Resource: "*",
              Condition: condition,
            },
          ]),
          targets,
        };
      },
      enforceS3BucketOwnerEnforced: (options?: BaseOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "EnforceS3BucketOwnerEnforced";
        const targets = options?.targets ?? (["root"] as Array<T>);
        return {
          name,
          description:
            "Enforces BucketOwnerEnforced object ownership on all new S3 buckets to prevent ACL-based attacks",
          content: buildPolicyDocument([
            {
              Sid: "EnforceS3BucketOwnerEnforced",
              Effect: "Deny",
              Action: "s3:CreateBucket",
              Resource: "*",
              Condition: {
                StringNotEquals: {
                  "s3:x-amz-object-ownership": "BucketOwnerEnforced",
                },
              },
            },
          ]),
          targets,
        };
      },
      preventLeavingOrganization: (options?: BaseOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "PreventLeavingOrganization";
        const targets = options?.targets ?? (["root"] as Array<T>);
        return {
          name,
          description: "Prevents any member account from leaving the AWS Organization",
          content: buildPolicyDocument([
            {
              Sid: "PreventLeavingOrganization",
              Effect: "Deny",
              Action: "organizations:LeaveOrganization",
              Resource: "*",
            },
          ]),
          targets,
        };
      },
      denyIamUserCreation: (options?: DenyIamUserCreationOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "DenyIamUserCreation";
        const targets = options?.targets ?? (["root"] as Array<T>);
        const condition = buildExemptRolesCondition(options?.exemptRoles ?? []);
        const statement: Record<string, unknown> = {
          Sid: "DenyIamUserCreation",
          Effect: "Deny",
          Action: ["iam:CreateUser", "iam:CreateAccessKey"],
          Resource: "*",
        };
        if (condition != null) {
          statement.Condition = condition;
        }
        return {
          name,
          description:
            "Blocks creation of IAM users and access keys to enforce IAM Identity Center usage",
          content: buildPolicyDocument([statement]),
          targets,
        };
      },
      preventDisablingEbsEncryption: (options?: BaseOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "PreventDisablingEbsEncryption";
        const targets = options?.targets ?? (["root"] as Array<T>);
        return {
          name,
          description:
            "Prevents disabling the EBS encryption-by-default setting so all new volumes remain encrypted",
          content: buildPolicyDocument([
            {
              Sid: "PreventDisablingEbsEncryption",
              Effect: "Deny",
              Action: "ec2:DisableEbsEncryptionByDefault",
              Resource: "*",
            },
          ]),
          targets,
        };
      },
      protectPasswordPolicy: (options: ProtectPasswordPolicyOptions<T>): PolicyEntry<T> => {
        if (options.exemptRoles.length === 0) {
          throw new Error(
            "protectPasswordPolicy: exemptRoles must contain at least one IAM role ARN pattern",
          );
        }

        const name = options.name ?? "ProtectPasswordPolicy";
        const targets = options.targets ?? (["root"] as Array<T>);
        const condition = { StringNotLike: { "aws:PrincipalARN": options.exemptRoles } };

        return {
          name,
          description:
            "Prevents modification or deletion of the IAM account password policy except by authorized roles",
          content: buildPolicyDocument([
            {
              Sid: "ProtectPasswordPolicy",
              Effect: "Deny",
              Action: ["iam:DeleteAccountPasswordPolicy", "iam:UpdateAccountPasswordPolicy"],
              Resource: "*",
              Condition: condition,
            },
          ]),
          targets,
        };
      },
      enforceDataPerimeter: (options: EnforceDataPerimeterOptions<T>): PolicyEntry<T> => {
        if (options.organizationId == null || options.organizationId === "") {
          throw new Error("enforceDataPerimeter: organizationId is required");
        }

        const name = options.name ?? "EnforceDataPerimeter";
        const targets = options.targets ?? (["root"] as Array<T>);

        const serviceLinkedRolePattern = "arn:aws:iam::*:role/aws-service-role/*";
        const exemptRolePatterns = [serviceLinkedRolePattern, ...(options.exemptRoles ?? [])];

        return {
          name,
          description:
            "Restricts access to only principals from the organization, preventing external AWS accounts from accessing resources",
          content: buildPolicyDocument([
            {
              Sid: "EnforceDataPerimeter",
              Effect: "Deny",
              Action: "*",
              Resource: "*",
              Condition: {
                StringNotEqualsIfExists: {
                  "aws:PrincipalOrgID": options.organizationId,
                },
                BoolIfExists: {
                  "aws:PrincipalIsAWSService": "false",
                },
                StringNotLike: {
                  "aws:PrincipalARN": exemptRolePatterns,
                },
              },
            },
          ]),
          targets,
        };
      },
    },
    security: {
      protectSecurityServicesComprehensive: (
        options: ExemptRolesRequiredOptions<T>,
      ): PolicyEntry<T> => {
        if (options.exemptRoles.length === 0) {
          throw new Error(
            "protectSecurityServicesComprehensive: exemptRoles must contain at least one IAM role ARN pattern",
          );
        }

        const name = options.name ?? "ProtectSecurityServicesComprehensive";
        const targets = options.targets ?? (["root"] as Array<T>);
        const condition = { StringNotLike: { "aws:PrincipalARN": options.exemptRoles } };

        const denyActions = [
          "guardduty:AcceptInvitation",
          "guardduty:ArchiveFindings",
          "guardduty:CreateDetector",
          "guardduty:CreateFilter",
          "guardduty:CreateIPSet",
          "guardduty:CreateMembers",
          "guardduty:CreatePublishingDestination",
          "guardduty:CreateSampleFindings",
          "guardduty:CreateThreatIntelSet",
          "guardduty:DeclineInvitations",
          "guardduty:DeleteDetector",
          "guardduty:DeleteFilter",
          "guardduty:DeleteInvitations",
          "guardduty:DeleteIPSet",
          "guardduty:DeleteMembers",
          "guardduty:DeletePublishingDestination",
          "guardduty:DeleteThreatIntelSet",
          "guardduty:DisassociateFromMasterAccount",
          "guardduty:DisassociateMembers",
          "guardduty:InviteMembers",
          "guardduty:StartMonitoringMembers",
          "guardduty:StopMonitoringMembers",
          "guardduty:TagResource",
          "guardduty:UnarchiveFindings",
          "guardduty:UntagResource",
          "guardduty:UpdateDetector",
          "guardduty:UpdateFilter",
          "guardduty:UpdateFindingsFeedback",
          "guardduty:UpdateIPSet",
          "guardduty:UpdatePublishingDestination",
          "guardduty:UpdateThreatIntelSet",
          "config:DeleteConfigRule",
          "config:DeleteConfigurationRecorder",
          "config:DeleteDeliveryChannel",
          "config:StopConfigurationRecorder",
          "cloudtrail:DeleteTrail",
          "cloudtrail:PutEventSelectors",
          "cloudtrail:StopLogging",
          "cloudtrail:UpdateTrail",
          "cloudtrail:CreateTrail",
          "securityhub:DeleteInvitations",
          "securityhub:DisableSecurityHub",
          "securityhub:DisassociateFromMasterAccount",
          "securityhub:DeleteMembers",
          "securityhub:DisassociateMembers",
        ];

        return {
          name,
          description:
            "Protects security services (GuardDuty, Config, CloudTrail, Security Hub) from tampering by denying destructive and configuration-weakening actions",
          content: buildPolicyDocument([
            {
              Sid: "ProtectSecurityServicesComprehensive",
              Effect: "Deny",
              Action: denyActions,
              Resource: "*",
              Condition: condition,
            },
          ]),
          targets,
        };
      },
      protectSecurityHubConfig: (options: ExemptRolesRequiredOptions<T>): PolicyEntry<T> => {
        if (options.exemptRoles.length === 0) {
          throw new Error(
            "protectSecurityHubConfig: exemptRoles must contain at least one IAM role ARN pattern",
          );
        }

        const name = options.name ?? "ProtectSecurityHubConfig";
        const targets = options.targets ?? (["root"] as Array<T>);
        const condition = { StringNotLike: { "aws:PrincipalARN": options.exemptRoles } };

        return {
          name,
          description:
            "Prevents weakening of Security Hub compliance standards and configurations except by authorized roles",
          content: buildPolicyDocument([
            {
              Sid: "ProtectSecurityHubConfig",
              Effect: "Deny",
              Action: [
                "securityhub:BatchDisableStandards",
                "securityhub:UpdateStandardsControl",
                "securityhub:UpdateSecurityHubConfiguration",
                "securityhub:UpdateOrganizationConfiguration",
                "securityhub:DisableImportFindingsForProduct",
                "securityhub:DeleteActionTarget",
                "securityhub:DeleteInsight",
                "securityhub:UpdateFindingAggregator",
              ],
              Resource: "*",
              Condition: condition,
            },
          ]),
          targets,
        };
      },
      restrictToSecurityOperations: (options?: BaseOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "RestrictToSecurityOperations";
        const targets = options?.targets ?? (["root"] as Array<T>);
        return {
          name,
          description:
            "Prevents workload deployment in security accounts to maintain separation of duties",
          content: buildPolicyDocument([
            {
              Sid: "RestrictToSecurityOperations",
              Effect: "Deny",
              Action: [
                "ec2:RunInstances",
                "rds:CreateDBInstance",
                "lambda:CreateFunction",
                "ecs:CreateCluster",
                "eks:CreateCluster",
              ],
              Resource: "*",
            },
          ]),
          targets,
        };
      },
      enforceMfaForIam: (options?: EnforceMfaForIamOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "EnforceMfaForIam";
        const targets = options?.targets ?? (["root"] as Array<T>);

        const condition: Record<string, Record<string, string | Array<string>>> = {
          BoolIfExists: {
            "aws:MultiFactorAuthPresent": "false",
          },
        };

        const exemptRolesCondition = buildExemptRolesCondition(options?.exemptRoles ?? []);
        if (exemptRolesCondition != null) {
          const stringNotLike = exemptRolesCondition.StringNotLike as Record<string, Array<string>>;
          condition.StringNotLike = stringNotLike;
        }

        return {
          name,
          description:
            "Requires MFA for sensitive IAM operations to prevent privilege escalation via stolen credentials",
          content: buildPolicyDocument([
            {
              Sid: "EnforceMfaForIam",
              Effect: "Deny",
              Action: [
                "iam:CreateUser",
                "iam:DeleteUser",
                "iam:AttachUserPolicy",
                "iam:AttachRolePolicy",
                "iam:CreateAccessKey",
                "iam:CreatePolicyVersion",
              ],
              Resource: "*",
              Condition: condition,
            },
          ]),
          targets,
        };
      },
    },
    production: {
      enforceEncryption: (options?: BaseOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "EnforceEncryption";
        const targets = options?.targets ?? (["root"] as Array<T>);
        return {
          name,
          description:
            "Enforces encryption on S3 uploads, EBS volumes, and RDS instances to prevent unencrypted data storage",
          content: buildPolicyDocument([
            {
              Sid: "DenyUnencryptedS3Uploads",
              Effect: "Deny",
              Action: "s3:PutObject",
              Resource: "*",
              Condition: {
                Null: {
                  "s3:x-amz-server-side-encryption": "true",
                },
              },
            },
            {
              Sid: "DenyUnencryptedEbsVolumes",
              Effect: "Deny",
              Action: "ec2:RunInstances",
              Resource: "arn:aws:ec2:*:*:volume/*",
              Condition: {
                Bool: {
                  "ec2:Encrypted": "false",
                },
              },
            },
            {
              Sid: "DenyUnencryptedRdsInstances",
              Effect: "Deny",
              Action: "rds:CreateDBInstance",
              Resource: "*",
              Condition: {
                Bool: {
                  "rds:StorageEncrypted": "false",
                },
              },
            },
          ]),
          targets,
        };
      },
      preventUnauthorizedTermination: (
        options: PreventUnauthorizedTerminationOptions<T>,
      ): PolicyEntry<T> => {
        if (options.approvedRoles.length === 0) {
          throw new Error(
            "preventUnauthorizedTermination: approvedRoles must contain at least one role ARN pattern",
          );
        }

        const name = options.name ?? "PreventUnauthorizedTermination";
        const targets = options.targets ?? (["root"] as Array<T>);

        return {
          name,
          description:
            "Prevents accidental termination of production resources by restricting destructive operations to approved roles",
          content: buildPolicyDocument([
            {
              Sid: "PreventUnauthorizedTermination",
              Effect: "Deny",
              Action: ["ec2:TerminateInstances", "rds:DeleteDBInstance", "dynamodb:DeleteTable"],
              Resource: "*",
              Condition: {
                StringNotLike: {
                  "aws:PrincipalARN": options.approvedRoles,
                },
              },
            },
          ]),
          targets,
        };
      },
      protectTaggedStacks: (options: ProtectTaggedStacksOptions<T>): PolicyEntry<T> => {
        if (options.exemptRoles.length === 0 || options.organizationTagValue === "") {
          throw new Error(
            "protectTaggedStacks: organizationTagValue and exemptRoles are both required",
          );
        }

        const name = options.name ?? "ProtectTaggedStacks";
        const targets = options.targets ?? (["root"] as Array<T>);
        const tagKey = options.tagKey ?? "organization";

        return {
          name,
          description:
            "Protects IaC-managed CloudFormation stacks from manual deletion by requiring a matching resource tag and restricting access to exempt roles",
          content: buildPolicyDocument([
            {
              Sid: "ProtectTaggedStacks",
              Effect: "Deny",
              Action: [
                "cloudformation:DeleteStack",
                "cloudformation:DeleteStackInstances",
                "cloudformation:DeleteStackSet",
              ],
              Resource: "*",
              Condition: {
                StringEquals: {
                  [`aws:ResourceTag/${tagKey}`]: options.organizationTagValue,
                },
                StringNotLike: {
                  "aws:PrincipalARN": options.exemptRoles,
                },
              },
            },
          ]),
          targets,
        };
      },
      enforceImdsV2: (options?: BaseOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "EnforceIMDSv2";
        const targets = options?.targets ?? (["root"] as Array<T>);
        return {
          name,
          description:
            "Requires IMDSv2 for all EC2 instances to prevent SSRF-based credential theft attacks",
          content: buildPolicyDocument([
            {
              Sid: "EnforceIMDSv2",
              Effect: "Deny",
              Action: "ec2:RunInstances",
              Resource: "arn:aws:ec2:*:*:instance/*",
              Condition: {
                StringNotEquals: {
                  "ec2:MetadataHttpTokens": "required",
                },
              },
            },
          ]),
          targets,
        };
      },
    },
    development: {
      preventExpensiveInstances: (
        options?: PreventExpensiveInstancesOptions<T>,
      ): PolicyEntry<T> => {
        const name = options?.name ?? "PreventExpensiveInstances";
        const targets = options?.targets ?? (["root"] as Array<T>);
        const denyNatGateway = options?.denyNatGateway ?? true;
        const denyIo2Volumes = options?.denyIo2Volumes ?? true;

        const allowedEc2InstanceTypes = options?.allowedEc2InstanceTypes ?? [
          "t3.*",
          "t3a.*",
          "t2.*",
          "m5.large",
          "m5.xlarge",
          "m6i.large",
          "m6i.xlarge",
        ];

        const allowedRdsInstanceClasses = options?.allowedRdsInstanceClasses ?? [
          "db.t3.*",
          "db.t4g.*",
        ];

        const statements: Array<Record<string, unknown>> = [];

        const ec2Statement: Record<string, unknown> = {
          Sid: "DenyExpensiveEc2Instances",
          Effect: "Deny",
          Action: "ec2:RunInstances",
          Resource: "arn:aws:ec2:*:*:instance/*",
        };
        if (allowedEc2InstanceTypes.length > 0) {
          ec2Statement.Condition = {
            "ForAnyValue:StringNotLike": {
              "ec2:InstanceType": allowedEc2InstanceTypes,
            },
          };
        }
        statements.push(ec2Statement);

        const rdsStatement: Record<string, unknown> = {
          Sid: "DenyExpensiveRdsInstances",
          Effect: "Deny",
          Action: "rds:CreateDBInstance",
          Resource: "*",
        };
        if (allowedRdsInstanceClasses.length > 0) {
          rdsStatement.Condition = {
            "ForAnyValue:StringNotLike": {
              "rds:DatabaseClass": allowedRdsInstanceClasses,
            },
          };
        }
        statements.push(rdsStatement);

        if (denyIo2Volumes) {
          statements.push({
            Sid: "DenyIo2Volumes",
            Effect: "Deny",
            Action: "ec2:CreateVolume",
            Resource: "*",
            Condition: {
              StringEquals: {
                "ec2:VolumeType": ["io2"],
              },
            },
          });
        }

        if (denyNatGateway) {
          statements.push({
            Sid: "DenyNatGateway",
            Effect: "Deny",
            Action: "ec2:CreateNatGateway",
            Resource: "*",
          });
        }

        return {
          name,
          description:
            "Prevents launching expensive EC2 instance types, RDS instance classes, io2 volumes, and NAT gateways in development accounts",
          content: buildPolicyDocument(statements),
          targets,
        };
      },
      blockReservedPurchases: (options?: BaseOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "BlockReservedPurchases";
        const targets = options?.targets ?? (["root"] as Array<T>);
        return {
          name,
          description:
            "Blocks reserved instance and savings plan purchases in development accounts to prevent long-term commitments",
          content: buildPolicyDocument([
            {
              Sid: "BlockReservedPurchases",
              Effect: "Deny",
              Action: [
                "ec2:PurchaseReservedInstancesOffering",
                "ec2:PurchaseHostReservation",
                "ec2:PurchaseScheduledInstances",
                "rds:PurchaseReservedDBInstancesOffering",
                "elasticache:PurchaseReservedCacheNodesOffering",
                "redshift:PurchaseReservedNodeOffering",
                "dynamodb:PurchaseReservedCapacityOfferings",
                "savingsplans:CreateSavingsPlan",
              ],
              Resource: "*",
            },
          ]),
          targets,
        };
      },
      preventExpensiveAiMl: (options?: BaseOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "PreventExpensiveAiMl";
        const targets = options?.targets ?? (["root"] as Array<T>);
        return {
          name,
          description:
            "Blocks access to expensive AI/ML services (SageMaker, EMR, Redshift) in development accounts",
          content: buildPolicyDocument([
            {
              Sid: "PreventExpensiveAiMl",
              Effect: "Deny",
              Action: [
                "sagemaker:CreateTrainingJob",
                "sagemaker:CreateHyperParameterTuningJob",
                "sagemaker:CreateNotebookInstance",
                "sagemaker:CreateEndpoint",
                "elasticmapreduce:RunJobFlow",
                "redshift:CreateCluster",
                "redshift-serverless:CreateWorkgroup",
              ],
              Resource: "*",
            },
          ]),
          targets,
        };
      },
      enforceResourceTagging: (options?: EnforceResourceTaggingOptions<T>): PolicyEntry<T> => {
        const requiredTags = options?.requiredTags ?? ["Environment", "Owner"];

        if (requiredTags.length === 0) {
          throw new Error("enforceResourceTagging: requiredTags must contain at least one tag key");
        }

        const name = options?.name ?? "EnforceResourceTagging";
        const targets = options?.targets ?? (["root"] as Array<T>);

        const nullCondition: Record<string, string> = {};
        for (const tagKey of requiredTags) {
          nullCondition[`aws:RequestTag/${tagKey}`] = "true";
        }

        return {
          name,
          description:
            "Enforces mandatory tags on EC2 and RDS resources for cost allocation and ownership tracking",
          content: buildPolicyDocument([
            {
              Sid: "EnforceResourceTaggingEc2",
              Effect: "Deny",
              Action: "ec2:RunInstances",
              Resource: ["arn:aws:ec2:*:*:instance/*", "arn:aws:ec2:*:*:volume/*"],
              Condition: {
                Null: nullCondition,
              },
            },
            {
              Sid: "EnforceResourceTaggingRds",
              Effect: "Deny",
              Action: "rds:CreateDBInstance",
              Resource: "*",
              Condition: {
                Null: nullCondition,
              },
            },
          ]),
          targets,
        };
      },
    },
    sandbox: {
      restrictToBasicServices: (options?: RestrictToBasicServicesOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "RestrictToBasicServices";
        const targets = options?.targets ?? (["root"] as Array<T>);

        const allowedServices = options?.allowedServices ?? [
          "ec2:*",
          "s3:*",
          "lambda:*",
          "dynamodb:*",
          "cloudwatch:*",
          "logs:*",
          "iam:*",
          "sts:*",
          "sns:*",
          "sqs:*",
          "apigateway:*",
        ];

        const allowedInstanceTypes = options?.allowedInstanceTypes ?? [
          "t2.micro",
          "t2.small",
          "t3.micro",
          "t3.small",
        ];

        return {
          name,
          description:
            "Restricts sandbox accounts to basic low-cost services and small instance types",
          content: buildPolicyDocument([
            {
              Sid: "DenyNonBasicServices",
              Effect: "Deny",
              NotAction: allowedServices,
              Resource: "*",
            },
            {
              Sid: "DenyExpensiveInstanceTypes",
              Effect: "Deny",
              Action: "ec2:RunInstances",
              Resource: "arn:aws:ec2:*:*:instance/*",
              Condition: {
                "ForAnyValue:StringNotLike": {
                  "ec2:InstanceType": allowedInstanceTypes,
                },
              },
            },
            {
              Sid: "DenyNetworkConnectivity",
              Effect: "Deny",
              Action: [
                "ec2:CreateVpcPeeringConnection",
                "ec2:AcceptVpcPeeringConnection",
                "ec2:CreateTransitGatewayVpcAttachment",
                "directconnect:*",
                "globalaccelerator:*",
              ],
              Resource: "*",
            },
          ]),
          targets,
        };
      },
      preventExternalSharing: (options?: BaseOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "PreventExternalSharing";
        const targets = options?.targets ?? (["root"] as Array<T>);
        return {
          name,
          description:
            "Prevents sandbox accounts from sharing resources with or accepting shares from external accounts",
          content: buildPolicyDocument([
            {
              Sid: "PreventExternalSharing",
              Effect: "Deny",
              Action: [
                "ram:CreateResourceShare",
                "ram:UpdateResourceShare",
                "ram:AssociateResourceShare",
                "ram:AcceptResourceShareInvitation",
              ],
              Resource: "*",
            },
          ]),
          targets,
        };
      },
    },
    suspended: {
      completeLockdown: (options: CompleteLockdownOptions<T>): PolicyEntry<T> => {
        if (options.exemptRoles.length === 0) {
          throw new Error(
            "completeLockdown: exemptRoles must contain at least one IAM role ARN pattern",
          );
        }

        const name = options.name ?? "SuspendedAccountLockdown";
        const targets = options.targets ?? (["root"] as Array<T>);

        return {
          name,
          description:
            "Completely locks down suspended accounts while preserving access for authorized admin and compliance roles",
          content: buildPolicyDocument([
            {
              Sid: "SuspendedAccountLockdown",
              Effect: "Deny",
              Action: "*",
              Resource: "*",
              Condition: {
                StringNotLike: {
                  "aws:PrincipalARN": options.exemptRoles,
                },
              },
            },
          ]),
          targets,
        };
      },
    },
    infrastructure: {
      restrictToNetworking: (options?: BaseOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "RestrictToNetworkingOnly";
        const targets = options?.targets ?? (["root"] as Array<T>);
        return {
          name,
          description:
            "Restricts network accounts to networking operations only, preventing mixed-purpose application hosting",
          content: buildPolicyDocument([
            {
              Sid: "AllowNetworkingOnly",
              Effect: "Deny",
              NotAction: [
                "ec2:*Vpc*",
                "ec2:*Subnet*",
                "ec2:*Gateway*",
                "ec2:*Route*",
                "ec2:*NetworkAcl*",
                "ec2:*SecurityGroup*",
                "ec2:*TransitGateway*",
                "ec2:Describe*",
                "directconnect:*",
                "route53:*",
                "route53resolver:*",
                "networkfirewall:*",
                "vpc-lattice:*",
                "cloudwatch:*",
                "logs:*",
                "iam:*",
                "sts:*",
              ],
              Resource: "*",
            },
            {
              Sid: "DenyComputeAndStorage",
              Effect: "Deny",
              Action: [
                "ec2:RunInstances",
                "rds:*",
                "s3:CreateBucket",
                "lambda:*",
                "ecs:*",
                "eks:*",
              ],
              Resource: "*",
            },
          ]),
          targets,
        };
      },
      protectVpcFlowLogs: (options?: ProtectVpcFlowLogsOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "ProtectVpcFlowLogs";
        const targets = options?.targets ?? (["root"] as Array<T>);
        const condition = buildExemptRolesCondition(options?.exemptRoles ?? []);

        const statement: Record<string, unknown> = {
          Sid: "ProtectVpcFlowLogs",
          Effect: "Deny",
          Action: ["ec2:DeleteFlowLogs", "logs:DeleteLogGroup"],
          Resource: "*",
        };

        if (condition != null) {
          statement.Condition = condition;
        }

        return {
          name,
          description:
            "Protects VPC Flow Logs from deletion to maintain network audit trails for security investigations",
          content: buildPolicyDocument([statement]),
          targets,
        };
      },
    },
    modern: {
      controlBedrockModels: (options?: ControlBedrockModelsOptions<T>): PolicyEntry<T> => {
        const deniedModelPatterns = options?.deniedModelPatterns ?? [
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-3-opus-*",
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-*",
          "arn:aws:bedrock:*::foundation-model/meta.llama3-1-405b-*",
        ];

        if (deniedModelPatterns.length === 0) {
          throw new Error(
            "controlBedrockModels: deniedModelPatterns must contain at least one model ARN pattern",
          );
        }

        const name = options?.name ?? "ControlBedrockModels";
        const targets = options?.targets ?? (["root"] as Array<T>);

        return {
          name,
          description:
            "Restricts which Bedrock foundation models can be invoked to control expensive model usage",
          content: buildPolicyDocument([
            {
              Sid: "ControlBedrockModels",
              Effect: "Deny",
              Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
              Resource: deniedModelPatterns,
            },
          ]),
          targets,
        };
      },
      restrictQDeveloperIam: (options?: BaseOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "RestrictQDeveloperIam";
        const targets = options?.targets ?? (["root"] as Array<T>);
        return {
          name,
          description:
            "Prevents IAM operations from being executed through chat interfaces like Amazon Q Developer",
          content: buildPolicyDocument([
            {
              Sid: "RestrictQDeveloperIam",
              Effect: "Deny",
              Action: [
                "iam:CreateUser",
                "iam:DeleteUser",
                "iam:CreateRole",
                "iam:DeleteRole",
                "iam:AttachUserPolicy",
                "iam:AttachRolePolicy",
                "iam:CreateAccessKey",
              ],
              Resource: "*",
              Condition: {
                StringEquals: {
                  "aws:CalledViaFirst": "chatbot.amazonaws.com",
                },
              },
            },
          ]),
          targets,
        };
      },
      requireVpcForSageMaker: (options?: BaseOptions<T>): PolicyEntry<T> => {
        const name = options?.name ?? "RequireVpcForSageMaker";
        const targets = options?.targets ?? (["root"] as Array<T>);
        return {
          name,
          description:
            "Requires VPC configuration for SageMaker resources to prevent public internet access",
          content: buildPolicyDocument([
            {
              Sid: "RequireVpcForSageMaker",
              Effect: "Deny",
              Action: ["sagemaker:CreateNotebookInstance", "sagemaker:CreateTrainingJob"],
              Resource: "*",
              Condition: {
                Null: {
                  "sagemaker:VpcSubnets": "true",
                },
              },
            },
          ]),
          targets,
        };
      },
    },
  };
}

function buildExemptRolesCondition(roles: Array<string>): Record<string, unknown> | undefined {
  if (roles.length === 0) return undefined;
  return { StringNotLike: { "aws:PrincipalARN": roles } };
}

function buildPolicyDocument(statements: Array<Record<string, unknown>>): Record<string, unknown> {
  return { Version: "2012-10-17", Statement: statements };
}

export { buildExemptRolesCondition, buildPolicyDocument };
export type { PolicyEntry, ScpCollection };
