# Security Baseline

The `withSecurityBaseline()` wrapper enables AWS security best practices — CloudTrail, AWS Config, GuardDuty, and root access management — through a single config enhancement.

## Overview

Import from the generated types:

```ts
import { withSecurityBaseline } from "./aws.config.types.js";
```

Every feature is independently opt-in. Omit a section or set `enabled: false` to skip it — no cost is incurred for disabled features. Some features separate free operations (delegated admin registration) from paid resources (S3 buckets, recorders, detectors), giving you granular cost control.

The function:

- Registers delegated administrators for enabled services
- Records StackSet deployment metadata for per-account infrastructure
- Validates that referenced account names exist in your config

## Quick Start

Add a Security OU with dedicated accounts:

```ts
{
  name: "Security",
  parentName: "root",
  accounts: [
    { name: "SecurityAudit", email: "security-audit@yourdomain.com", tags: [] },
    { name: "LogArchive", email: "log-archive@yourdomain.com", tags: [] },
  ],
},
```

Wrap your config:

```ts
import { withSecurityBaseline } from "./aws.config.types.js";

const awsConfig = withSecurityBaseline(
  {
    organizationalUnits: [
      /* your config */
    ],
    delegatedAdministrators: [],
    // ... rest of standard config
  },
  {
    cloudTrail: {
      enabled: true,
      delegatedAdminAccount: "SecurityAudit",
      logArchiveAccount: "LogArchive",
      organizationTrail: true,
    },
    configRecorder: {
      enabled: true,
      delegatedAdminAccount: "SecurityAudit",
      deliveryBucketAccount: "LogArchive",
      targets: ["root"],
    },
    guardDuty: {
      enabled: true,
      delegatedAdminAccount: "SecurityAudit",
    },
  },
);

export default awsConfig;
```

Run `plan` and `apply` for the changes to take effect.

## Features

### CloudTrail

CloudTrail records API activity across your AWS accounts. The security baseline offers two levels:

#### `enabled: true` (free)

Registers the delegated admin account for CloudTrail. This gives you:

- Cross-account access to CloudTrail **Event History** from the delegated admin console
- Ability to manage trails centrally

No S3 buckets or trails are created. No cost.

#### `organizationTrail: true` (~$1–10/mo)

Creates an S3 bucket in the log archive account and an organization-wide trail that delivers events from all accounts:

- All management events captured centrally
- Long-term retention in S3 (Event History only retains 90 days)
- Enables Athena queries across the full history

#### Event History vs Organization Trail

| Capability               | Event History (free) | Organization Trail        |
| ------------------------ | -------------------- | ------------------------- |
| Cost                     | Free                 | ~$1–10/mo (S3 storage)    |
| Retention                | 90 days              | Unlimited (S3)            |
| Scope                    | Per-account          | All accounts              |
| Searchable               | Console lookup       | Console + S3 + Athena     |
| Data events (S3, Lambda) | No                   | Configurable              |
| Setup                    | Automatic            | `organizationTrail: true` |

#### Viewing CloudTrail data

**Console** — Sign in to the delegated admin account → [CloudTrail console](https://console.aws.amazon.com/cloudtrail/) → Event history or Trails.

**CLI:**

```bash
# Recent events (Event History)
aws cloudtrail lookup-events --max-results 10

# List trail events from S3 (organization trail)
aws s3 ls s3://cloudtrail-o-XXXXX-REGION/AWSLogs/ --recursive | tail -20
```

**Athena** — Create a table over the S3 trail bucket for SQL queries across all accounts and time ranges.

📖 [AWS CloudTrail User Guide](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html)

---

### AWS Config

AWS Config records resource configuration changes across your organization. It tracks what resources exist, how they're configured, and how configurations change over time.

#### What it does

- Records configuration items for every supported resource type
- Delivers snapshots to a central S3 bucket in the log archive account
- Creates an organization-wide aggregator in the delegated admin account
- Enables cross-account resource queries

#### Cost

- **$0.003 per configuration item** recorded
- Typical idle org (~20 accounts): $12/mo
- Active org: $30–90/mo

No free tier.

#### Configurable Parameters

| Parameter                | Default              | Description                      |
| ------------------------ | -------------------- | -------------------------------- |
| `recordAllResourceTypes` | `true`               | Record all resource types        |
| `includeGlobalResources` | `true`               | Include IAM and global resources |
| `deliveryFrequency`      | `"TwentyFour_Hours"` | Snapshot delivery frequency      |

#### Viewing Config data

**Console** — Sign in to the delegated admin account → [AWS Config console](https://console.aws.amazon.com/config/) → Use the **Aggregator** view to see resources across all accounts.

The tool automatically creates an organization-wide aggregator named `OrganizationAggregator` during `apply`.

**Advanced queries** (Config console → Advanced queries):

```sql
-- Find all S3 buckets without encryption
SELECT resourceId, accountId, awsRegion, configuration
WHERE resourceType = 'AWS::S3::Bucket'
AND configuration.serverSideEncryptionConfiguration IS NULL

-- List all EC2 instances across the org
SELECT resourceId, accountId, awsRegion, resourceName
WHERE resourceType = 'AWS::EC2::Instance'

-- Find public security groups
SELECT resourceId, accountId, configuration.ipPermissions
WHERE resourceType = 'AWS::EC2::SecurityGroup'
AND configuration.ipPermissions.ipRanges LIKE '%0.0.0.0/0%'
```

**S3 delivery data:**

```bash
aws s3 ls s3://config-delivery-o-XXXXX-REGION/AWSLogs/ --recursive | tail -20
```

Bucket structure: `AWSLogs/{AccountId}/Config/{Region}/{Year}/{Month}/{Day}/`

📖 [AWS Config Developer Guide](https://docs.aws.amazon.com/config/latest/developerguide/WhatIsConfig.html)

---

### GuardDuty

GuardDuty is a threat detection service that continuously monitors for malicious activity and unauthorized behavior.

#### What it monitors

- **CloudTrail management events** — unusual API calls, unauthorized access patterns
- **VPC Flow Logs** — port scanning, communication with known malicious IPs
- **DNS queries** — communication with cryptocurrency mining pools, command-and-control servers

#### Cost

- Based on event volume (CloudTrail events analyzed, VPC flow log data, DNS queries)
- Typical idle org (~20 accounts): $20–40/mo
- Active org: $50–100/mo
- **30-day free trial** per account

#### Configurable Parameters

| Parameter                    | Default             | Description              |
| ---------------------------- | ------------------- | ------------------------ |
| `findingPublishingFrequency` | `"FIFTEEN_MINUTES"` | Finding export frequency |

#### Viewing findings

**Console** — Sign in to the delegated admin account → [GuardDuty console](https://console.aws.amazon.com/guardduty/). Findings from all member accounts appear automatically.

**CLI:**

```bash
# List recent high-severity findings across all accounts
aws guardduty list-findings \
  --detector-id $(aws guardduty list-detectors --query 'DetectorIds[0]' --output text) \
  --finding-criteria '{"Criterion":{"severity":{"Gte":7}}}'
```

📖 [Amazon GuardDuty User Guide](https://docs.aws.amazon.com/guardduty/latest/ug/what-is-guardduty.html)

---

### Root Access Management

Delegates root credential management to the delegated admin account, allowing centralized control over member account root credentials without needing per-account root passwords.

#### What it does

- Registers `iam.amazonaws.com` as a delegated admin service for your security account
- Enables the delegated admin to perform privileged root actions on member accounts (e.g., recover access, delete root credentials)

#### Cost

Free. No additional AWS resources are created.

#### When to use it

- You want to eliminate root credentials on member accounts
- You need centralized emergency access without maintaining per-account root passwords
- Compliance requirements mandate root credential management

## Cost Estimate (~20 accounts, eu-central-1)

| Service    | What drives cost                              | Idle org (~$)  | Active org (~$)  |
| ---------- | --------------------------------------------- | -------------- | ---------------- |
| AWS Config | Configuration items recorded ($0.003/item)    | $12/mo         | $30–90/mo        |
| GuardDuty  | CloudTrail events, VPC Flow Logs, DNS queries | $20–40/mo      | $50–100/mo       |
| CloudTrail | S3 storage (org management trail is free)     | $2–5/mo        | $10–30/mo        |
| S3 storage | Config snapshots + CloudTrail logs            | $1–3/mo        | $3–10/mo         |
| **Total**  |                                               | **~$35–50/mo** | **~$100–230/mo** |

Use the [AWS Pricing Calculator](https://calculator.aws/) for precise estimates. GuardDuty offers a 30-day free trial per account.

**Zero-cost features:** CloudTrail delegation (`enabled: true` without `organizationTrail`), root access management, and SCPs incur no AWS charges.

## Disabling Features

Each feature is independently opt-in. Set `enabled: false` to skip a feature:

```ts
withSecurityBaseline(config, {
  cloudTrail: { enabled: false },
  configRecorder: {
    enabled: true,
    delegatedAdminAccount: "SecurityAudit",
    deliveryBucketAccount: "LogArchive",
    targets: ["root"],
  },
  guardDuty: { enabled: false },
});
```

After disabling a feature, existing StackSet infrastructure must be removed manually:

1. Update the `protectSecurityServices` SCP to unprotect the service being removed:
   ```ts
   policies.scp.protectSecurityServices({
     protect: { cloudTrail: true, config: true, guardDuty: false },
   });
   ```
2. Run `plan` and `apply --allow-destructive` to update the SCP and deregister delegated admins.
3. Delete StackSet instances and the StackSet:
   ```bash
   aws cloudformation delete-stack-instances \
     --stack-set-name guardduty-member \
     --deployment-targets OrganizationalUnitIds=r-xxxx \
     --regions eu-central-1 --no-retain-stacks \
     --operation-preferences FailureTolerancePercentage=100
   # Wait for completion, then:
   aws cloudformation delete-stack-set --stack-set-name guardduty-member
   ```

> **Why manual?** Automatic deletion of security infrastructure is dangerous. Resources like detectors and recorders may have data retention requirements, so explicit confirmation is required.

## SCP Protection

The `protectSecurityServices` SCP helper prevents member accounts from disabling security services deployed by the baseline:

```ts
policies.scp.protectSecurityServices({
  protect: { cloudTrail: true, config: true, guardDuty: false },
});
```

All services default to `true` (protected) when `protect` is omitted.

Use selective protection when you need to tear down a specific service — unprotect it first, then remove StackSet instances.

## Recommended Permission Sets

After deploying the security baseline, grant team members access to security data in the delegated admin account using built-in helpers:

| Helper                                          | Name                 | Description                                          |
| ----------------------------------------------- | -------------------- | ---------------------------------------------------- |
| `policies.permissionSet.readOnlyAuditor()`      | ReadOnlyAuditor      | ViewOnlyAccess across all services                   |
| `policies.permissionSet.cloudTrailAnalyst()`    | CloudTrailAnalyst    | CloudTrail logs + Athena queries                     |
| `policies.permissionSet.configCompliance()`     | ConfigCompliance     | AWS Config read + resource inventory                 |
| `policies.permissionSet.securityInvestigator()` | SecurityInvestigator | Combined CloudTrail, Config, GuardDuty, Security Hub |

All helpers accept optional `{ name?, sessionDuration? }` to override defaults.

### Usage

```typescript
permissionSets: [
  // ...existing permission sets
  policies.permissionSet.readOnlyAuditor(),
  policies.permissionSet.cloudTrailAnalyst(),
  policies.permissionSet.configCompliance(),
  policies.permissionSet.securityInvestigator(),
],

groups: [
  // ...existing groups
  {
    displayName: "Security",
    description: "",
    members: ["your-user-here"],
  },
],

assignments: [
  // ...existing assignments
  {
    permissionSet: "ReadOnlyAuditor",
    group: "Security",
    accounts: ["SecurityAudit"],
  },
  {
    permissionSet: "SecurityInvestigator",
    group: "Security",
    accounts: ["SecurityAudit"],
  },
],
```

## Template Overrides

Default CloudFormation templates ship with the package. To customize:

```bash
npx aws-accounts config reveal
```

This copies templates to `./templates/` in your project. Local copies take precedence over package defaults. The tool won't overwrite existing files.

## Manual Cleanup

All resources created by this tool are tagged with `ManagedBy = beesolve-aws-accounts`.

### Listing managed resources

```bash
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=ManagedBy,Values=beesolve-aws-accounts \
  --region eu-central-1
```

### Deletion order

Resources have dependencies — delete them in this order:

1. **Delete StackSet instances** (removes Config/GuardDuty/IAM roles from member accounts):

   ```bash
   aws cloudformation delete-stack-instances \
     --stack-set-name config-recorder \
     --deployment-targets OrganizationalUnitIds=r-xxxx \
     --regions eu-central-1 --no-retain-stacks
   # Wait: aws cloudformation describe-stack-set-operation --stack-set-name config-recorder --operation-id <id>
   # Repeat for: guardduty-member, security-setup
   ```

2. **Delete StackSets**:

   ```bash
   aws cloudformation delete-stack-set --stack-set-name config-recorder
   aws cloudformation delete-stack-set --stack-set-name guardduty-member
   aws cloudformation delete-stack-set --stack-set-name security-setup
   ```

3. **Empty and delete Config delivery bucket** (in LogArchive account):

   ```bash
   aws s3 rm s3://config-delivery-o-XXXXX-REGION --recursive
   aws s3 rb s3://config-delivery-o-XXXXX-REGION
   ```

4. **Deregister delegated administrators**:

   ```bash
   aws organizations deregister-delegated-administrator \
     --account-id SECURITY_ACCOUNT_ID --service-principal config.amazonaws.com
   # Repeat for: guardduty.amazonaws.com, iam.amazonaws.com, cloudtrail.amazonaws.com
   ```

5. **Detach and delete SCPs** (find them via tag):

   ```bash
   aws organizations list-policies --filter SERVICE_CONTROL_POLICY
   # For each tagged SCP: detach from all targets, then delete
   ```

6. **Empty and delete state bucket**:

   ```bash
   aws s3 rm s3://beesolve-aws-accounts-state-XXXXX --recursive
   aws s3 rb s3://beesolve-aws-accounts-state-XXXXX
   ```

7. **Delete Lambda, role, and log group**:

   ```bash
   aws lambda delete-function --function-name beesolve-aws-accounts
   aws iam delete-role-policy --role-name beesolve-aws-accounts-lambda-role --policy-name LambdaPolicy
   aws iam delete-role --role-name beesolve-aws-accounts-lambda-role
   aws logs delete-log-group --log-group-name /aws/lambda/beesolve-aws-accounts
   ```

8. **Delete local files**:
   ```bash
   rm aws.context.json
   ```

### Security implications

| Resource               | Impact of removal                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Config recorder        | Stops recording resource configuration changes. Compliance rules stop evaluating.                                         |
| GuardDuty              | Stops threat detection (compromised credentials, crypto mining, unusual API calls). Existing findings remain for 90 days. |
| Config delivery bucket | Historical configuration snapshots are lost. Consider keeping for audit retention requirements.                           |
| SCPs                   | Permission boundaries removed — accounts can perform previously denied actions.                                           |

> **Recommendation**: If you only want to stop using this tool but keep security monitoring active, skip steps 1–3 and leave Config/GuardDuty running independently. Only remove the tool infrastructure (steps 6–8).
