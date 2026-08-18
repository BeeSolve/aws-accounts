# Requirements Document

## Introduction

A reusable SCP (Service Control Policy) collection module based on the [TowardsTheCloud 28 production-ready SCP examples](https://towardsthecloud.com/blog/aws-scp-examples). The collection implements each SCP as an independently callable TypeScript function following the existing `PolicyEntry<T>` pattern from `src/security.ts`. Functions are organized by OU category (foundation, security, production, development, sandbox, suspended, infrastructure, modern) and exposed through a namespaced factory function.

## Glossary

- **SCP_Collection**: The module exporting the `toScpCollection()` factory function that returns all SCP functions grouped by OU category
- **PolicyEntry**: The return type `{ name: string; description: string; content: Record<string, unknown>; targets: Array<T> }` representing a single SCP document
- **Foundation_SCP**: An SCP intended for organization-wide application at the root level or every OU
- **Security_OU_SCP**: An SCP intended for the Security OU protecting audit, logging, and security tooling accounts
- **Production_OU_SCP**: An SCP intended for the Production OU enforcing encryption, change control, and resource protection
- **Development_OU_SCP**: An SCP intended for the Development OU enforcing cost controls and safe experimentation
- **Sandbox_OU_SCP**: An SCP intended for the Sandbox OU with aggressive spending limits and service restrictions
- **Suspended_OU_SCP**: An SCP intended for the Suspended OU providing complete account lockdown
- **Infrastructure_OU_SCP**: An SCP intended for the Infrastructure OU restricting accounts to designated functions
- **Modern_Services_SCP**: An SCP governing newer AWS services (Bedrock, Amazon Q, SageMaker) requiring specific guardrails
- **Exempt_Roles**: IAM role ARN patterns excluded from deny statements via `StringNotLike` conditions on `aws:PrincipalARN`

## Requirements

### Requirement 1: Module Structure and Factory Function

**User Story:** As a developer, I want to import a single factory function that exposes all SCP rules grouped by category, so that I can compose policies declaratively in my AWS config.

#### Acceptance Criteria

1. THE SCP_Collection SHALL export a generic factory function `toScpCollection<T extends string, A extends string>()` that returns an object with keys: `foundation`, `security`, `production`, `development`, `sandbox`, `suspended`, `infrastructure`, `modern`, where `T` represents organizational unit target names and `A` represents AWS account identifiers, consistent with the existing `toPolicies<T, A>()` convention
2. WHEN the factory function is invoked, THE SCP_Collection SHALL return at least one rule function under each category key, where each function accepts a typed options object and returns a `PolicyEntry<T>` containing `name`, `description`, `content`, and `targets` fields
3. THE SCP_Collection SHALL be exported from a dedicated module file separate from the existing `src/security.ts`
4. THE SCP_Collection SHALL use `import type` for type-only imports and follow the project's ESM-only module format
5. THE SCP_Collection SHALL reuse the existing `PolicyEntry<T>` type pattern (name, description, content, targets) without introducing new return types
6. IF a rule function receives an options object missing a required field or containing an invalid value, THEN THE SCP_Collection SHALL throw an `Error` with a descriptive message identifying the rule name and the invalid field

### Requirement 2: Foundation SCPs — Deny Root User Access

**User Story:** As a security engineer, I want to deny all actions by the root user across member accounts, so that root credentials cannot be used for any AWS operations.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `foundation.denyRootUser` function SHALL return a PolicyEntry with a single statement where Effect is `Deny`, Action is `*`, Resource is `*`, and a `StringLike` condition on `aws:PrincipalArn` matches `arn:aws:iam::*:root`
2. THE SCP_Collection `foundation.denyRootUser` function SHALL accept an optional `targets` parameter defaulting to `["root"]` and include it as the `targets` field of the returned PolicyEntry
3. THE SCP_Collection `foundation.denyRootUser` function SHALL accept an optional `name` parameter defaulting to `"DenyRootUser"` and include it as the `name` field of the returned PolicyEntry

### Requirement 3: Foundation SCPs — Deny Unsupported Regions

**User Story:** As a compliance officer, I want to restrict AWS resource creation to approved regions only, so that data residency requirements are enforced and blast radius is limited.

#### Acceptance Criteria

1. WHEN invoked with an `allowedRegions` array, THE SCP_Collection `foundation.denyUnsupportedRegions` function SHALL return a PolicyEntry with a Deny statement using `NotAction` for global services and a `StringNotEquals` condition on `aws:RequestedRegion` containing each region from `allowedRegions`
2. THE SCP_Collection `foundation.denyUnsupportedRegions` function SHALL include in the `NotAction` list the following global service action prefixes: `iam:*`, `sts:*`, `cloudfront:*`, `route53:*`, `route53domains:*`, `organizations:*`, `support:*`, `budgets:*`, `ce:*`, `waf:*`, `wafv2:*`, `shield:*`, `health:*`, `globalaccelerator:*`, and S3 global operations
3. IF the `exemptRoles` array is provided and contains one or more IAM role ARN patterns, THEN THE SCP_Collection `foundation.denyUnsupportedRegions` function SHALL add a `StringNotLike` condition on `aws:PrincipalARN` to the Deny statement listing each pattern from `exemptRoles`
4. THE SCP_Collection `foundation.denyUnsupportedRegions` function SHALL require the `allowedRegions` parameter as an array of 1 or more valid AWS region identifier strings
5. IF the `exemptRoles` parameter is omitted or is an empty array, THEN THE SCP_Collection `foundation.denyUnsupportedRegions` function SHALL return a PolicyEntry without a `StringNotLike` condition on `aws:PrincipalARN`

### Requirement 4: Foundation SCPs — Enforce S3 Bucket Owner Enforced

**User Story:** As a security engineer, I want to enforce the BucketOwnerEnforced setting on all new S3 buckets, so that ACL-based ownership transfer attacks are prevented.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `foundation.enforceS3BucketOwnerEnforced` function SHALL return a PolicyEntry with a Deny statement on `s3:CreateBucket` with Resource `"*"`, conditioned on `s3:x-amz-object-ownership` not equaling `"BucketOwnerEnforced"`
2. THE SCP_Collection `foundation.enforceS3BucketOwnerEnforced` function SHALL accept optional `targets` and `name` parameters, where `name` defaults to `"EnforceS3BucketOwnerEnforced"` when omitted

### Requirement 5: Foundation SCPs — Prevent Leaving Organization

**User Story:** As an organization administrator, I want to prevent any member account from leaving the organization, so that governance and billing structures remain intact.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `foundation.preventLeavingOrganization` function SHALL return a PolicyEntry with a Deny statement on `organizations:LeaveOrganization` with `Resource` set to `"*"` and no Condition block
2. THE SCP_Collection `foundation.preventLeavingOrganization` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"PreventLeavingOrganization"` and `targets` defaulting to `["root"]`

### Requirement 6: Foundation SCPs — Deny IAM User and Access Key Creation

**User Story:** As a security engineer, I want to block creation of IAM users and access keys, so that all human access uses IAM Identity Center with automatic credential rotation.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `foundation.denyIamUserCreation` function SHALL return a PolicyEntry with a Deny statement on actions `iam:CreateUser` and `iam:CreateAccessKey`, with Resource set to `*`
2. THE SCP_Collection `foundation.denyIamUserCreation` function SHALL accept optional `targets`, `name`, and `exemptRoles` parameters, where `name` defaults to `"DenyIamUserCreation"` and `targets` defaults to `["root"]`
3. IF `exemptRoles` is provided and non-empty, THEN THE SCP_Collection `foundation.denyIamUserCreation` function SHALL include a Condition with `StringNotLike` on `aws:PrincipalARN` matching each exempt role pattern
4. IF `exemptRoles` is not provided or is empty, THEN THE SCP_Collection `foundation.denyIamUserCreation` function SHALL return the Deny statement without any Condition block

### Requirement 7: Foundation SCPs — Prevent Disabling EBS Encryption

**User Story:** As a compliance officer, I want to prevent disabling the EBS encryption-by-default setting, so that all new volumes remain encrypted.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `foundation.preventDisablingEbsEncryption` function SHALL return a PolicyEntry with a Deny statement on `ec2:DisableEbsEncryptionByDefault` applied to Resource `"*"`
2. THE SCP_Collection `foundation.preventDisablingEbsEncryption` function SHALL accept an optional `targets` parameter defaulting to `["root"]`
3. THE SCP_Collection `foundation.preventDisablingEbsEncryption` function SHALL accept an optional `name` parameter defaulting to `"PreventDisablingEbsEncryption"`

### Requirement 8: Foundation SCPs — Protect IAM Password Policy

**User Story:** As a compliance officer, I want to prevent modification of the IAM password policy except by authorized IaC roles, so that compliance-mandated password requirements remain enforced.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `foundation.protectPasswordPolicy` function SHALL return a PolicyEntry with a Deny statement on actions `iam:DeleteAccountPasswordPolicy` and `iam:UpdateAccountPasswordPolicy` applied to Resource `"*"`
2. THE SCP_Collection `foundation.protectPasswordPolicy` function SHALL accept a required `exemptRoles` array of 1 or more IAM role ARN patterns excluded via a `StringNotLike` condition on `aws:PrincipalARN`
3. IF `exemptRoles` is provided as an empty array, THEN THE SCP_Collection `foundation.protectPasswordPolicy` function SHALL throw an Error indicating that at least one exempt role ARN pattern is required
4. THE SCP_Collection `foundation.protectPasswordPolicy` function SHALL accept optional `targets` and `name` parameters, defaulting `name` to `"ProtectPasswordPolicy"` when omitted

### Requirement 9: Foundation SCPs — Enforce Data Perimeter Controls

**User Story:** As a security architect, I want to restrict access to only principals from my organization, so that external AWS accounts cannot access resources in my accounts.

#### Acceptance Criteria

1. WHEN invoked with an `organizationId` string matching the pattern `o-[a-z0-9]{10,32}`, THE SCP_Collection `foundation.enforceDataPerimeter` function SHALL return a PolicyEntry with a Deny statement using `StringNotEqualsIfExists` on `aws:PrincipalOrgID` with the provided organizationId, `BoolIfExists` on `aws:PrincipalIsAWSService` set to `"false"`, and `StringNotLike` exemptions for service-linked roles on `aws:PrincipalARN`
2. THE SCP_Collection `foundation.enforceDataPerimeter` function SHALL require the `organizationId` parameter
3. IF `organizationId` is missing, null, or empty, THEN THE SCP_Collection `foundation.enforceDataPerimeter` function SHALL throw an Error indicating that organizationId is required
4. THE SCP_Collection `foundation.enforceDataPerimeter` function SHALL accept optional `exemptRoles`, `targets`, and `name` parameters
5. IF `exemptRoles` is provided, THEN THE function SHALL include those patterns in the `StringNotLike` condition alongside the default service-linked role exemption

### Requirement 10: Security OU SCPs — Comprehensive Security Services Protection

**User Story:** As a security engineer, I want to protect all security services (GuardDuty, Config, CloudTrail, Security Hub) from tampering, so that audit trails and threat detection remain immutable.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `security.protectSecurityServicesComprehensive` function SHALL return a PolicyEntry with a Deny statement covering destructive and configuration-weakening actions for CloudTrail (delete, stop logging, update trail, put event selectors), Config (delete configuration recorder, delete delivery channel, stop configuration recorder), GuardDuty (delete detector, delete members, disassociate from administrator account, disassociate members, update detector), and Security Hub (disable security hub, delete members, disassociate from administrator account, disassociate members, batch disable standards, update standards control)
2. THE SCP_Collection `security.protectSecurityServicesComprehensive` function SHALL accept a required `exemptRoles` array of 1 or more IAM role ARN patterns excluded via `StringNotLike` on `aws:PrincipalARN`
3. THE SCP_Collection `security.protectSecurityServicesComprehensive` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"ProtectSecurityServicesComprehensive"`
4. IF `exemptRoles` is provided as an empty array, THEN THE SCP_Collection SHALL throw an error indicating that at least one exempt role is required

### Requirement 11: Security OU SCPs — Protect Security Hub Configuration

**User Story:** As a security engineer, I want to prevent weakening of Security Hub compliance standards and configurations, so that compliance monitoring remains effective.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `security.protectSecurityHubConfig` function SHALL return a PolicyEntry with a Deny statement on the following Security Hub actions: `securityhub:BatchDisableStandards`, `securityhub:UpdateStandardsControl`, `securityhub:UpdateSecurityHubConfiguration`, `securityhub:UpdateOrganizationConfiguration`, `securityhub:DisableImportFindingsForProduct`, `securityhub:DeleteActionTarget`, `securityhub:DeleteInsight`, `securityhub:UpdateFindingAggregator`, with Resource set to `"*"`
2. THE SCP_Collection `security.protectSecurityHubConfig` function SHALL accept a required `exemptRoles` array containing 1 or more role ARN patterns, and SHALL apply a `StringNotLike` condition on `aws:PrincipalARN` using each pattern
3. THE SCP_Collection `security.protectSecurityHubConfig` function SHALL accept optional `targets` and `name` parameters
4. IF `name` is not provided, THEN THE SCP_Collection `security.protectSecurityHubConfig` function SHALL use a default policy name of `"ProtectSecurityHubConfig"`

### Requirement 12: Security OU SCPs — Restrict to Security Operations Only

**User Story:** As a security architect, I want to prevent workload deployment in security accounts, so that separation of duties is maintained and audit integrity is protected.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `security.restrictToSecurityOperations` function SHALL return a PolicyEntry containing a Deny statement with actions `ec2:RunInstances`, `rds:CreateDBInstance`, `lambda:CreateFunction`, `ecs:CreateCluster`, and `eks:CreateCluster` applied to all resources (`"*"`)
2. THE SCP_Collection `security.restrictToSecurityOperations` function SHALL accept an optional `targets` parameter defaulting to `["root"]`
3. THE SCP_Collection `security.restrictToSecurityOperations` function SHALL accept an optional `name` parameter defaulting to `"RestrictToSecurityOperations"`

### Requirement 13: Security OU SCPs — Enforce MFA for Sensitive IAM Operations

**User Story:** As a security engineer, I want to require MFA for sensitive IAM operations, so that automated attacks using stolen credentials cannot escalate privileges.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `security.enforceMfaForIam` function SHALL return a PolicyEntry containing a Deny statement on actions `iam:CreateUser`, `iam:DeleteUser`, `iam:AttachUserPolicy`, `iam:AttachRolePolicy`, `iam:CreateAccessKey`, and `iam:CreatePolicyVersion` with Resource `"*"` and a `BoolIfExists` condition requiring `aws:MultiFactorAuthPresent` equals `"false"`
2. WHEN `exemptRoles` is provided and non-empty, THE SCP_Collection `security.enforceMfaForIam` function SHALL include a `StringNotLike` condition on `aws:PrincipalARN` excluding the specified role patterns from the Deny
3. WHEN `exemptRoles` is not provided or is empty, THE SCP_Collection `security.enforceMfaForIam` function SHALL apply the Deny statement without any role-based exclusion
4. THE SCP_Collection `security.enforceMfaForIam` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"EnforceMfaForIam"`

### Requirement 14: Production OU SCPs — Enforce Encryption on All Data

**User Story:** As a compliance officer, I want to enforce encryption on all production S3 uploads, EBS volumes, and RDS instances, so that unencrypted data storage is technically impossible.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `production.enforceEncryption` function SHALL return a PolicyEntry containing a Deny statement that blocks `s3:PutObject` when the condition key `s3:x-amz-server-side-encryption` is null (absent from the request)
2. WHEN invoked, THE SCP_Collection `production.enforceEncryption` function SHALL return a PolicyEntry containing a Deny statement that blocks `ec2:RunInstances` targeting `arn:aws:ec2:*:*:volume/*` when the condition key `ec2:Encrypted` equals `"false"`
3. WHEN invoked, THE SCP_Collection `production.enforceEncryption` function SHALL return a PolicyEntry containing a Deny statement that blocks `rds:CreateDBInstance` when the condition key `rds:StorageEncrypted` equals `"false"`
4. THE SCP_Collection `production.enforceEncryption` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"EnforceEncryption"`

### Requirement 15: Production OU SCPs — Prevent Unauthorized Resource Termination

**User Story:** As an operations engineer, I want to prevent accidental termination of production resources, so that only approved roles can perform destructive operations.

#### Acceptance Criteria

1. WHEN invoked with an `approvedRoles` array, THE SCP_Collection `production.preventUnauthorizedTermination` function SHALL return a PolicyEntry with a Deny statement on actions `ec2:TerminateInstances`, `rds:DeleteDBInstance`, and `dynamodb:DeleteTable` for Resource `*`, with a `StringNotLike` condition on `aws:PrincipalARN` exempting each entry in the `approvedRoles` array
2. THE SCP_Collection `production.preventUnauthorizedTermination` function SHALL require the `approvedRoles` parameter as an array containing 1 or more role-pattern strings
3. IF the `approvedRoles` parameter is missing or an empty array, THEN THE SCP_Collection `production.preventUnauthorizedTermination` function SHALL throw an error indicating that at least one approved role must be provided
4. THE SCP_Collection `production.preventUnauthorizedTermination` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"PreventUnauthorizedTermination"`

### Requirement 16: Production OU SCPs — Protect Tagged CloudFormation Stacks

**User Story:** As an operations engineer, I want to protect IaC-managed CloudFormation stacks from manual deletion, so that infrastructure changes only happen through deployment pipelines.

#### Acceptance Criteria

1. WHEN invoked with an `organizationTagValue` string and a non-empty `exemptRoles` array, THE SCP_Collection `production.protectTaggedStacks` function SHALL return a PolicyEntry containing a Deny statement on actions `cloudformation:DeleteStack`, `cloudformation:DeleteStackInstances`, and `cloudformation:DeleteStackSet` for all resources, conditioned on `aws:ResourceTag/{tagKey}` matching the tag value using `StringEquals`
2. THE SCP_Collection `production.protectTaggedStacks` function SHALL include a `StringNotLike` condition on `aws:PrincipalARN` exempting each entry in the `exemptRoles` array
3. THE SCP_Collection `production.protectTaggedStacks` function SHALL accept a required `exemptRoles` array containing at least 1 IAM role ARN pattern
4. THE SCP_Collection `production.protectTaggedStacks` function SHALL accept an optional `tagKey` parameter defaulting to `"organization"`, used to construct the condition key `aws:ResourceTag/{tagKey}`
5. THE SCP_Collection `production.protectTaggedStacks` function SHALL accept optional `targets` and `name` parameters
6. IF `exemptRoles` is empty or `organizationTagValue` is an empty string, THEN THE SCP_Collection `production.protectTaggedStacks` function SHALL throw an error indicating that both a non-empty tag value and at least one exempt role are required

### Requirement 17: Production OU SCPs — Enforce IMDSv2

**User Story:** As a security engineer, I want to require IMDSv2 for all EC2 instances, so that SSRF-based credential theft attacks are prevented.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `production.enforceImdsV2` function SHALL return a PolicyEntry with a Deny statement on `ec2:RunInstances` targeting `arn:aws:ec2:*:*:instance/*` conditioned with `StringNotEquals` on `ec2:MetadataHttpTokens` not equaling `"required"`
2. THE SCP_Collection `production.enforceImdsV2` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"EnforceIMDSv2"`

### Requirement 18: Development OU SCPs — Prevent Expensive Instance Types

**User Story:** As a FinOps engineer, I want to restrict development accounts to cost-effective instance types, so that development costs remain predictable.

#### Acceptance Criteria

1. WHEN invoked with optional `allowedEc2InstanceTypes` and `allowedRdsInstanceClasses` arrays, THE SCP_Collection `development.preventExpensiveInstances` function SHALL return a PolicyEntry containing a Deny statement for `ec2:RunInstances` conditioned on instance types not matching the allowed patterns, a Deny statement for `rds:CreateDBInstance` conditioned on instance classes not matching the allowed patterns, a Deny statement for `ec2:CreateVolume` restricted to io2 volume types, and a Deny statement for `ec2:CreateNatGateway`
2. THE SCP_Collection `development.preventExpensiveInstances` function SHALL provide defaults when arrays are omitted: EC2 allows `t3.*`, `t3a.*`, `t2.*`, `m5.large`, `m5.xlarge`, `m6i.large`, `m6i.xlarge`; RDS allows `db.t3.*`, `db.t4g.*`
3. THE SCP_Collection `development.preventExpensiveInstances` function SHALL accept optional `denyNatGateway` (default true), `denyIo2Volumes` (default true), `targets`, and `name` parameters
4. IF `denyNatGateway` is false, THEN THE function SHALL omit the NAT Gateway deny statement; IF `denyIo2Volumes` is false, THEN THE function SHALL omit the io2 volume deny statement
5. IF `allowedEc2InstanceTypes` or `allowedRdsInstanceClasses` is provided as an empty array, THEN THE function SHALL deny all instance types or all instance classes respectively

### Requirement 19: Development OU SCPs — Block Reserved Instance and Savings Plans Purchases

**User Story:** As a FinOps engineer, I want to prevent non-production accounts from purchasing Reserved Instances or Savings Plans, so that commitment purchases are centrally managed.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `development.blockReservedPurchases` function SHALL return a PolicyEntry containing a Deny statement on `ec2:PurchaseReservedInstancesOffering`, `ec2:PurchaseHostReservation`, `ec2:PurchaseScheduledInstances`, `rds:PurchaseReservedDBInstancesOffering`, `elasticache:PurchaseReservedCacheNodesOffering`, `redshift:PurchaseReservedNodeOffering`, `dynamodb:PurchaseReservedCapacityOfferings`, and `savingsplans:CreateSavingsPlan` applied to all resources
2. THE SCP_Collection `development.blockReservedPurchases` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"BlockReservedPurchases"`

### Requirement 20: Development OU SCPs — Prevent Expensive AI/ML Services

**User Story:** As a FinOps engineer, I want to block access to expensive AI/ML services in development accounts, so that experimentation with SageMaker, EMR, and Redshift requires explicit approval.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `development.preventExpensiveAiMl` function SHALL return a PolicyEntry with a Deny statement covering `sagemaker:CreateTrainingJob`, `sagemaker:CreateHyperParameterTuningJob`, `sagemaker:CreateNotebookInstance`, `sagemaker:CreateEndpoint`, `elasticmapreduce:RunJobFlow`, `redshift:CreateCluster`, and `redshift-serverless:CreateWorkgroup`, applied to all resources
2. THE SCP_Collection `development.preventExpensiveAiMl` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"PreventExpensiveAiMl"`

### Requirement 21: Development OU SCPs — Enforce Resource Tagging

**User Story:** As a FinOps engineer, I want to enforce mandatory tags on EC2 and RDS resources, so that cost allocation and ownership tracking are possible.

#### Acceptance Criteria

1. WHEN invoked with a `requiredTags` array containing 1 or more tag key names, THE SCP_Collection `development.enforceResourceTagging` function SHALL return a PolicyEntry with Deny statements on `ec2:RunInstances` and `rds:CreateDBInstance` conditioned on `Null` checks for `aws:RequestTag/<tagKey>` set to `"true"` for each required tag
2. THE SCP_Collection `development.enforceResourceTagging` function SHALL provide default `requiredTags` of `["Environment", "Owner"]`
3. THE SCP_Collection `development.enforceResourceTagging` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"EnforceResourceTagging"`
4. IF `requiredTags` is provided as an empty array, THEN THE SCP_Collection `development.enforceResourceTagging` function SHALL throw an Error indicating that at least one tag key is required

### Requirement 22: Sandbox OU SCPs — Restrict to Basic Services

**User Story:** As a platform engineer, I want to restrict sandbox accounts to only basic low-cost services and tiny instances, so that sandbox spending remains minimal.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `sandbox.restrictToBasicServices` function SHALL return a PolicyEntry containing: a Deny with NotAction permitting only the default allowed services (EC2, S3, Lambda, DynamoDB, CloudWatch, Logs, IAM, STS, SNS, SQS, API Gateway), a Deny restricting `ec2:RunInstances` to only the allowed instance types via an `ec2:InstanceType` condition, and a Deny for network connectivity actions (`ec2:CreateVpcPeeringConnection`, `ec2:AcceptVpcPeeringConnection`, `ec2:CreateTransitGatewayVpcAttachment`, `directconnect:*`, `globalaccelerator:*`)
2. THE SCP_Collection `sandbox.restrictToBasicServices` function SHALL accept an optional `allowedServices` array to override the default basic services list used in the NotAction statement
3. THE SCP_Collection `sandbox.restrictToBasicServices` function SHALL accept an optional `allowedInstanceTypes` array defaulting to `["t2.micro", "t2.small", "t3.micro", "t3.small"]`
4. THE SCP_Collection `sandbox.restrictToBasicServices` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"RestrictToBasicServices"`

### Requirement 23: Sandbox OU SCPs — Prevent External Resource Sharing

**User Story:** As a security engineer, I want to prevent sandbox accounts from sharing resources with or accepting shares from external accounts, so that sandbox isolation is maintained.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `sandbox.preventExternalSharing` function SHALL return a PolicyEntry with a Deny statement on actions `ram:CreateResourceShare`, `ram:UpdateResourceShare`, `ram:AssociateResourceShare`, and `ram:AcceptResourceShareInvitation`, applied to all resources
2. THE SCP_Collection `sandbox.preventExternalSharing` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"PreventExternalSharing"`

### Requirement 24: Suspended OU SCPs — Complete Account Lockdown

**User Story:** As a security engineer, I want to completely lock down suspended accounts while preserving access for authorized admin and compliance roles, so that compromised or decommissioned accounts are immediately quarantined.

#### Acceptance Criteria

1. WHEN invoked with an `exemptRoles` array containing 1 or more IAM role ARN patterns, THE SCP_Collection `suspended.completeLockdown` function SHALL return a PolicyEntry with a Deny statement on all actions (`"*"`) for all resources (`"*"`) with a `StringNotLike` condition on `aws:PrincipalARN` listing each entry from the `exemptRoles` array
2. IF the `exemptRoles` parameter is missing or an empty array, THEN THE SCP_Collection `suspended.completeLockdown` function SHALL throw an Error indicating that at least one exempt role ARN pattern is required
3. THE SCP_Collection `suspended.completeLockdown` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"SuspendedAccountLockdown"`

### Requirement 25: Infrastructure OU SCPs — Restrict to Networking Only

**User Story:** As a platform engineer, I want to restrict network accounts to networking operations only, so that they cannot become mixed-purpose application hosts.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `infrastructure.restrictToNetworking` function SHALL return a PolicyEntry containing a Deny statement with a NotAction list permitting only networking services: EC2 VPC/Subnet/Gateway/Route/SecurityGroup/TransitGateway operations, `ec2:Describe*`, `directconnect:*`, `route53:*`, `route53resolver:*`, `networkfirewall:*`, `vpc-lattice:*`, `cloudwatch:*`, `logs:*`, `iam:*`, `sts:*`
2. WHEN invoked, THE SCP_Collection `infrastructure.restrictToNetworking` function SHALL also include an explicit Deny statement blocking `ec2:RunInstances`, `rds:*`, `s3:CreateBucket`, `lambda:*`, `ecs:*`, and `eks:*`
3. THE SCP_Collection `infrastructure.restrictToNetworking` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"RestrictToNetworkingOnly"`

### Requirement 26: Infrastructure OU SCPs — Protect VPC Flow Logs

**User Story:** As a security engineer, I want to protect VPC Flow Logs from deletion, so that network audit trails remain intact for security investigations.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `infrastructure.protectVpcFlowLogs` function SHALL return a PolicyEntry with a Deny statement on actions `ec2:DeleteFlowLogs` and `logs:DeleteLogGroup` applied to all resources (`"*"`)
2. WHEN `exemptRoles` is provided with one or more role ARN patterns, THE SCP_Collection `infrastructure.protectVpcFlowLogs` function SHALL include a `StringNotLike` condition on `aws:PrincipalARN` excluding those principals from the Deny
3. IF `exemptRoles` is omitted or empty, THEN THE SCP_Collection `infrastructure.protectVpcFlowLogs` function SHALL return the Deny statement with no Condition block
4. THE SCP_Collection `infrastructure.protectVpcFlowLogs` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"ProtectVpcFlowLogs"`

### Requirement 27: Modern Services SCPs — Control Bedrock Model Access

**User Story:** As a FinOps engineer, I want to restrict which Bedrock foundation models can be invoked, so that expensive model usage requires explicit approval.

#### Acceptance Criteria

1. WHEN invoked with a `deniedModelPatterns` array containing 1 or more resource ARN patterns, THE SCP_Collection `modern.controlBedrockModels` function SHALL return a PolicyEntry with a Deny statement on `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` where the Resource field contains exactly the provided ARN patterns
2. WHEN invoked without a `deniedModelPatterns` argument, THE function SHALL use default denied model patterns: `arn:aws:bedrock:*::foundation-model/anthropic.claude-3-opus-*`, `arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-*`, `arn:aws:bedrock:*::foundation-model/meta.llama3-1-405b-*`
3. THE SCP_Collection `modern.controlBedrockModels` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"ControlBedrockModels"`
4. IF `deniedModelPatterns` is provided as an empty array, THEN THE function SHALL throw an Error indicating that at least 1 denied model pattern is required

### Requirement 28: Modern Services SCPs — Restrict Amazon Q Developer Operations

**User Story:** As a security engineer, I want to prevent IAM operations from being executed through chat interfaces, so that sensitive privilege changes require proper authentication context.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `modern.restrictQDeveloperIam` function SHALL return a PolicyEntry containing a Deny statement that blocks actions `iam:CreateUser`, `iam:DeleteUser`, `iam:CreateRole`, `iam:DeleteRole`, `iam:AttachUserPolicy`, `iam:AttachRolePolicy`, and `iam:CreateAccessKey` on all resources, conditioned on `aws:CalledViaFirst` equaling `"chatbot.amazonaws.com"`
2. THE SCP_Collection `modern.restrictQDeveloperIam` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"RestrictQDeveloperIam"`

### Requirement 29: Modern Services SCPs — Require VPC for SageMaker

**User Story:** As a security engineer, I want to require VPC configuration for SageMaker workloads, so that data exfiltration through public internet access is prevented.

#### Acceptance Criteria

1. WHEN invoked, THE SCP_Collection `modern.requireVpcForSageMaker` function SHALL return a PolicyEntry with a Deny statement on `sagemaker:CreateNotebookInstance` and `sagemaker:CreateTrainingJob` using a `Null` condition on `sagemaker:VpcSubnets` set to `"true"`
2. THE SCP_Collection `modern.requireVpcForSageMaker` function SHALL accept optional `targets` and `name` parameters, with `name` defaulting to `"RequireVpcForSageMaker"`

### Requirement 30: Shared Options Pattern and Defaults

**User Story:** As a developer, I want all SCP functions to follow a consistent options pattern with sensible defaults, so that the API is predictable and easy to use.

#### Acceptance Criteria

1. THE SCP_Collection SHALL use a consistent options pattern where every function accepts at minimum `{ targets?: Array<T>; name?: string }` with `targets` defaulting to `["root"]`
2. WHEN a function accepts `exemptRoles`, THE SCP_Collection SHALL apply each entry as an ARN glob pattern in a `StringNotLike` condition on `aws:PrincipalARN` in the policy statement
3. THE SCP_Collection SHALL generate valid IAM policy documents with `Version: "2012-10-17"` and Statement arrays where each statement contains `Sid`, `Effect`, `Action` (or `NotAction`), and `Resource` fields
4. IF an `exemptRoles` array is empty or undefined on a function that has it as optional, THEN THE SCP_Collection SHALL omit the `Condition` block from the statement entirely
5. WHEN multiple `exemptRoles` entries are provided, THE SCP_Collection SHALL combine them into a single `Condition` block with a `StringNotLike` containing an array of all ARN patterns
