# SCP Collection

A reusable library of 28 production-ready AWS Service Control Policies (SCPs) organized by OU category. Based on the [Towards the Cloud SCP examples](https://towardsthecloud.com/blog/aws-scp-examples).

## Overview

Import from the package:

```ts
import { toScpCollection } from "@beesolve/aws-accounts/scpCollection";
```

The factory function returns SCP rule functions organized into 8 categories matching common OU structures:

| Category         | SCPs | Purpose                              |
| ---------------- | ---- | ------------------------------------ |
| `foundation`     | 8    | Organization-wide guardrails         |
| `security`       | 4    | Security OU restrictions             |
| `production`     | 4    | Production workload protection       |
| `development`    | 4    | Cost control and guardrails for dev  |
| `sandbox`        | 2    | Heavily restricted experimentation   |
| `suspended`      | 1    | Locked-down accounts pending closure |
| `infrastructure` | 2    | Networking-only accounts             |
| `modern`         | 3    | AI/ML service governance             |

Each function returns a `PolicyEntry<T>` compatible with the `serviceControlPolicies` config array.

## Quick Start

```ts
import { toScpCollection } from "@beesolve/aws-accounts/scpCollection";

// In your aws.config.types.ts, the types are bound to your OU/account names.
// For standalone usage, use string generics:
const scps = toScpCollection<string, string>();

// Apply to your config
const awsConfig = {
  policies: {
    serviceControlPolicies: [
      scps.foundation.denyRootUser(),
      scps.foundation.denyUnsupportedRegions({ allowedRegions: ["eu-central-1", "us-east-1"] }),
      scps.foundation.preventLeavingOrganization(),
      scps.production.enforceEncryption({ targets: ["Production"] }),
      scps.development.preventExpensiveInstances({ targets: ["Development"] }),
      scps.suspended.completeLockdown({
        exemptRoles: ["arn:aws:iam::*:role/OrganizationAdmin"],
        targets: ["Suspended"],
      }),
    ],
  },
};
```

## Common Options

All SCP functions accept these base options:

| Option    | Type       | Default    | Description                            |
| --------- | ---------- | ---------- | -------------------------------------- |
| `targets` | `string[]` | `["root"]` | OUs or accounts to attach the SCP to   |
| `name`    | `string`   | varies     | Custom policy name (overrides default) |

Many functions also accept:

| Option        | Type       | Required | Description                                                                     |
| ------------- | ---------- | -------- | ------------------------------------------------------------------------------- |
| `exemptRoles` | `string[]` | varies   | IAM role ARN patterns exempted from the deny (e.g. `arn:aws:iam::*:role/Admin`) |

---

## Foundation SCPs

Applied organization-wide to establish baseline security guardrails.

### `foundation.denyRootUser`

Denies all actions by the root user across member accounts.

```ts
scps.foundation.denyRootUser();
```

### `foundation.denyUnsupportedRegions`

Denies access to AWS services in unsupported regions while allowing global services (IAM, CloudFront, Route 53, etc.) to continue working.

```ts
scps.foundation.denyUnsupportedRegions({
  allowedRegions: ["eu-central-1", "eu-west-1", "us-east-1"],
  exemptRoles: ["arn:aws:iam::*:role/OrganizationAdmin"], // optional
});
```

| Option           | Type       | Required | Description                                      |
| ---------------- | ---------- | -------- | ------------------------------------------------ |
| `allowedRegions` | `string[]` | yes      | Regions that remain accessible (throws on empty) |
| `exemptRoles`    | `string[]` | no       | Roles bypassing region restriction               |

### `foundation.enforceS3BucketOwnerEnforced`

Enforces `BucketOwnerEnforced` object ownership on all new S3 buckets to prevent ACL-based attacks.

```ts
scps.foundation.enforceS3BucketOwnerEnforced();
```

### `foundation.preventLeavingOrganization`

Prevents any member account from leaving the AWS Organization.

```ts
scps.foundation.preventLeavingOrganization();
```

### `foundation.denyIamUserCreation`

Blocks creation of IAM users and access keys to enforce IAM Identity Center usage.

```ts
scps.foundation.denyIamUserCreation({
  exemptRoles: ["arn:aws:iam::*:role/BreakGlass"], // optional
});
```

### `foundation.preventDisablingEbsEncryption`

Prevents disabling the EBS encryption-by-default setting.

```ts
scps.foundation.preventDisablingEbsEncryption();
```

### `foundation.protectPasswordPolicy`

Prevents modification or deletion of the IAM account password policy except by authorized roles.

```ts
scps.foundation.protectPasswordPolicy({
  exemptRoles: ["arn:aws:iam::*:role/SecurityAdmin"], // required, throws on empty
});
```

### `foundation.enforceDataPerimeter`

Restricts access to only principals from the organization, preventing external AWS accounts from accessing resources.

```ts
scps.foundation.enforceDataPerimeter({
  organizationId: "o-abc123def4", // required, throws on empty
  exemptRoles: ["arn:aws:iam::*:role/ExternalIntegration"], // optional
});
```

| Option           | Type       | Required | Description                                           |
| ---------------- | ---------- | -------- | ----------------------------------------------------- |
| `organizationId` | `string`   | yes      | AWS Organization ID (throws on empty)                 |
| `exemptRoles`    | `string[]` | no       | Additional roles exempted beyond service-linked roles |

---

## Security OU SCPs

Applied to Security OU accounts to protect security services and enforce separation of duties.

### `security.protectSecurityServicesComprehensive`

Denies destructive actions across GuardDuty, AWS Config, CloudTrail, and Security Hub.

```ts
scps.security.protectSecurityServicesComprehensive({
  exemptRoles: ["arn:aws:iam::*:role/SecurityAutomation"], // required, throws on empty
});
```

### `security.protectSecurityHubConfig`

Prevents weakening of Security Hub compliance standards and configurations.

```ts
scps.security.protectSecurityHubConfig({
  exemptRoles: ["arn:aws:iam::*:role/SecurityAutomation"], // required, throws on empty
});
```

### `security.restrictToSecurityOperations`

Prevents workload deployment (EC2, RDS, Lambda, ECS, EKS) in security accounts to maintain separation of duties.

```ts
scps.security.restrictToSecurityOperations({ targets: ["Security"] });
```

### `security.enforceMfaForIam`

Requires MFA for sensitive IAM operations to prevent privilege escalation via stolen credentials.

```ts
scps.security.enforceMfaForIam({
  exemptRoles: ["arn:aws:iam::*:role/PipelineRole"], // optional
});
```

---

## Production OU SCPs

Applied to production workloads for encryption enforcement and accidental-deletion protection.

### `production.enforceEncryption`

Enforces encryption on S3 uploads, EBS volumes, and RDS instances.

```ts
scps.production.enforceEncryption({ targets: ["Production"] });
```

### `production.preventUnauthorizedTermination`

Restricts destructive operations (EC2 terminate, RDS delete, DynamoDB delete table) to approved roles only.

```ts
scps.production.preventUnauthorizedTermination({
  approvedRoles: ["arn:aws:iam::*:role/InfraAdmin"], // required, throws on empty
  targets: ["Production"],
});
```

### `production.protectTaggedStacks`

Protects IaC-managed CloudFormation stacks from manual deletion by requiring a matching resource tag.

```ts
scps.production.protectTaggedStacks({
  organizationTagValue: "beesolve", // required, throws on empty
  exemptRoles: ["arn:aws:iam::*:role/DeployRole"], // required, throws on empty
  tagKey: "organization", // optional, defaults to "organization"
  targets: ["Production"],
});
```

### `production.enforceImdsV2`

Requires IMDSv2 for all EC2 instances to prevent SSRF-based credential theft.

```ts
scps.production.enforceImdsV2({ targets: ["Production"] });
```

---

## Development OU SCPs

Cost-control guardrails for development and staging environments.

### `development.preventExpensiveInstances`

Limits EC2 instance types, RDS instance classes, and optionally blocks io2 volumes and NAT gateways.

```ts
scps.development.preventExpensiveInstances({
  allowedEc2InstanceTypes: ["t3.*", "t3a.*", "m5.large"], // optional, has sensible defaults
  allowedRdsInstanceClasses: ["db.t3.*", "db.t4g.*"], // optional, has sensible defaults
  denyNatGateway: true, // optional, defaults to true
  denyIo2Volumes: true, // optional, defaults to true
  targets: ["Development"],
});
```

Default allowed EC2 types: `t3.*`, `t3a.*`, `t2.*`, `m5.large`, `m5.xlarge`, `m6i.large`, `m6i.xlarge`
Default allowed RDS classes: `db.t3.*`, `db.t4g.*`

### `development.blockReservedPurchases`

Blocks all reserved instance and savings plan purchases.

```ts
scps.development.blockReservedPurchases({ targets: ["Development"] });
```

### `development.preventExpensiveAiMl`

Blocks expensive AI/ML service actions (SageMaker training, EMR, Redshift).

```ts
scps.development.preventExpensiveAiMl({ targets: ["Development"] });
```

### `development.enforceResourceTagging`

Enforces mandatory tags on EC2 instances/volumes and RDS instances.

```ts
scps.development.enforceResourceTagging({
  requiredTags: ["Environment", "Owner", "CostCenter"], // optional, defaults to ["Environment", "Owner"]
  targets: ["Development"],
});
```

Throws on empty `requiredTags` array.

---

## Sandbox OU SCPs

Heavily restricted environment for experimentation.

### `sandbox.restrictToBasicServices`

Restricts to a whitelist of basic services and small instance types. Blocks network connectivity to other accounts.

```ts
scps.sandbox.restrictToBasicServices({
  allowedServices: [
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
  ], // optional, has defaults
  allowedInstanceTypes: ["t2.micro", "t3.micro", "t3.small"], // optional, has defaults
  targets: ["Sandbox"],
});
```

### `sandbox.preventExternalSharing`

Prevents sharing resources externally via AWS RAM.

```ts
scps.sandbox.preventExternalSharing({ targets: ["Sandbox"] });
```

---

## Suspended OU SCPs

For accounts pending closure.

### `suspended.completeLockdown`

Denies all actions except for specified admin/compliance roles.

```ts
scps.suspended.completeLockdown({
  exemptRoles: ["arn:aws:iam::*:role/OrganizationAdmin"], // required, throws on empty
  targets: ["Suspended"],
});
```

---

## Infrastructure OU SCPs

For accounts dedicated to networking (transit gateways, VPCs, DNS).

### `infrastructure.restrictToNetworking`

Restricts to networking operations only. Blocks compute, storage, Lambda, and container services.

```ts
scps.infrastructure.restrictToNetworking({ targets: ["Infrastructure"] });
```

### `infrastructure.protectVpcFlowLogs`

Prevents deletion of VPC Flow Logs and their CloudWatch log groups.

```ts
scps.infrastructure.protectVpcFlowLogs({
  exemptRoles: ["arn:aws:iam::*:role/NetworkAdmin"], // optional
  targets: ["Infrastructure"],
});
```

---

## Modern / AI SCPs

Governance for AI and ML services.

### `modern.controlBedrockModels`

Restricts which Bedrock foundation models can be invoked. Targets expensive models by default.

```ts
scps.modern.controlBedrockModels({
  deniedModelPatterns: [
    "arn:aws:bedrock:*::foundation-model/anthropic.claude-3-opus-*",
    "arn:aws:bedrock:*::foundation-model/meta.llama3-1-405b-*",
  ], // optional, has defaults; throws on empty
  targets: ["Development", "Sandbox"],
});
```

Default denied models: Claude 3 Opus, Claude 3.5 Sonnet, Llama 3.1 405B.

### `modern.restrictQDeveloperIam`

Prevents IAM operations from being executed through chat interfaces like Amazon Q Developer.

```ts
scps.modern.restrictQDeveloperIam();
```

### `modern.requireVpcForSageMaker`

Requires VPC configuration for SageMaker notebook instances and training jobs.

```ts
scps.modern.requireVpcForSageMaker({ targets: ["Production"] });
```

---

## Full Example

A comprehensive multi-OU configuration:

```ts
import { toScpCollection } from "@beesolve/aws-accounts/scpCollection";
import type { AwsConfig } from "./aws.config.types.js";

const scps = toScpCollection<string, string>();
const adminRole = "arn:aws:iam::*:role/OrganizationAdmin";

const awsConfig: AwsConfig = {
  // ... OUs, accounts, etc.
  policies: {
    serviceControlPolicies: [
      // Foundation — applies to entire org
      scps.foundation.denyRootUser(),
      scps.foundation.denyUnsupportedRegions({
        allowedRegions: ["eu-central-1", "us-east-1"],
        exemptRoles: [adminRole],
      }),
      scps.foundation.preventLeavingOrganization(),
      scps.foundation.denyIamUserCreation({ exemptRoles: [adminRole] }),
      scps.foundation.preventDisablingEbsEncryption(),
      scps.foundation.enforceS3BucketOwnerEnforced(),
      scps.foundation.enforceDataPerimeter({
        organizationId: "o-abc123def4",
        exemptRoles: [adminRole],
      }),

      // Security OU
      scps.security.protectSecurityServicesComprehensive({
        exemptRoles: [adminRole],
        targets: ["Security"],
      }),
      scps.security.restrictToSecurityOperations({ targets: ["Security"] }),

      // Production OU
      scps.production.enforceEncryption({ targets: ["Production"] }),
      scps.production.enforceImdsV2({ targets: ["Production"] }),
      scps.production.preventUnauthorizedTermination({
        approvedRoles: [adminRole],
        targets: ["Production"],
      }),

      // Development OU
      scps.development.preventExpensiveInstances({ targets: ["Development"] }),
      scps.development.blockReservedPurchases({ targets: ["Development"] }),
      scps.development.enforceResourceTagging({ targets: ["Development"] }),

      // Sandbox OU
      scps.sandbox.restrictToBasicServices({ targets: ["Sandbox"] }),
      scps.sandbox.preventExternalSharing({ targets: ["Sandbox"] }),

      // Suspended OU
      scps.suspended.completeLockdown({
        exemptRoles: [adminRole],
        targets: ["Suspended"],
      }),

      // AI governance
      scps.modern.controlBedrockModels({ targets: ["Development", "Sandbox"] }),
    ],
  },
};

export default awsConfig;
```

## Validation

Functions validate required parameters at runtime and throw descriptive `Error` messages:

- `denyUnsupportedRegions` — throws on empty `allowedRegions`
- `protectPasswordPolicy` — throws on empty `exemptRoles`
- `enforceDataPerimeter` — throws on empty/missing `organizationId`
- `protectSecurityServicesComprehensive` — throws on empty `exemptRoles`
- `protectSecurityHubConfig` — throws on empty `exemptRoles`
- `preventUnauthorizedTermination` — throws on empty `approvedRoles`
- `protectTaggedStacks` — throws on empty `exemptRoles` or `organizationTagValue`
- `completeLockdown` — throws on empty `exemptRoles`
- `controlBedrockModels` — throws on empty `deniedModelPatterns`
- `enforceResourceTagging` — throws on empty `requiredTags`

## SCP Size Limits

AWS enforces a 5,120-character limit on SCP policy documents. All policies in this collection stay well within that limit with typical usage (up to 10 exempt roles, 5 regions). If you provide unusually large arrays, verify the generated JSON stays under the limit.

## Relationship to `policies.scp`

The existing `policies.scp` helpers in `aws.config.types.ts` (e.g. `policies.scp.blockExpensiveResources`, `policies.scp.protectSecurityServices`) remain available and are unaffected. The SCP collection is a separate, more comprehensive library you can use alongside or instead of those helpers.
