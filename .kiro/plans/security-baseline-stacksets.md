# Implementation Plan — `withSecurityBaseline()` + StackSets

## Problem Statement

Provide a turnkey config wrapper that enables AWS security best practices (Organization CloudTrail trail, AWS Config recorders, GuardDuty) through a single function. Infrastructure that requires per-account deployment (Config recorders) is managed via CloudFormation StackSets. Default templates ship with the package; users can override them locally.

## Architecture

```
aws.config.ts                    Remote Lambda
┌──────────────────────┐         ┌──────────────────────────┐
│ withSecurityBaseline( │         │ • Registers delegated     │
│   { ...userConfig },  │  plan/  │   administrators          │
│   { cloudTrail: ... } │ ──────► │ • Creates org trail       │
│ )                     │  apply  │ • Deploys StackSets       │
└──────────────────────┘         │   (Config, GuardDuty)     │
                                 └──────────────────────────┘
                                          │
          StackSet auto-deploys to ───────┘
          all member accounts in target OUs
```

## File Rename

`src/policies.ts` → `src/security.ts`

Export path: `@beesolve/aws-accounts/security`

The file contains:
- `toPolicies<T, A>()` — SCP, backup policy, and permission set pattern builders
- `withSecurityBaseline()` — config wrapper for security infrastructure

## User-Facing API

### `aws.config.ts`

```typescript
import { iam, policies, type AwsConfig } from "./aws.config.types.js";
import { withSecurityBaseline } from "@beesolve/aws-accounts/security";

const { scp, backupPolicy, permissionSet } = policies;

const awsConfig = withSecurityBaseline(
  {
    organizationalUnits: [
      { name: "root", parentName: null, accounts: [] },
      {
        name: "Security",
        parentName: "root",
        accounts: [
          { name: "SecurityAudit", email: "security-audit@yourdomain.com", tags: [] },
          { name: "LogArchive", email: "log-archive@yourdomain.com", tags: [] },
        ],
      },
      // ... rest of user config
    ],
    permissionSets: [
      permissionSet.securityInvestigator(),
      permissionSet.cloudTrailAnalyst(),
      // ...
    ],
    policies: {
      serviceControlPolicies: [
        scp.blockExpensiveResources({
          allowedEc2InstanceTypes: ["t3.micro", "t3.small", "t4g.medium", "m8g.medium", "m8g.large"],
          targets: ["root"],
        }),
        scp.protectSecurityServices({ targets: ["root"] }),
      ],
      backupPolicies: [
        backupPolicy.dailyWithRetention({ regions: ["eu-central-1"], targets: ["root"] }),
      ],
      // ...
    },
    // ... standard config (users, groups, assignments, etc.)
  },
  {
    cloudTrail: {
      enabled: true,
      delegatedAdminAccount: "SecurityAudit",
      logArchiveAccount: "LogArchive",
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

### Documentation snippet (ready-to-copy Security OU)

The README provides this recommended starting point:

```typescript
// Recommended Security OU — copy into your organizationalUnits array:
{
  name: "Security",
  parentName: "root",
  accounts: [
    {
      name: "SecurityAudit",
      email: "security-audit@yourdomain.com",  // ← change this
      tags: [],
    },
    {
      name: "LogArchive",
      email: "log-archive@yourdomain.com",     // ← change this
      tags: [],
    },
  ],
},
```

## Types

```typescript
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
    recordAllResourceTypes?: boolean;       // default: true
    includeGlobalResources?: boolean;       // default: true
    deliveryFrequency?: "One_Hour" | "Three_Hours" | "Six_Hours" | "Twelve_Hours" | "TwentyFour_Hours";
  };
  guardDuty?: {
    enabled: boolean;
    delegatedAdminAccount: A;
    targets?: T[];
    findingPublishingFrequency?: "FIFTEEN_MINUTES" | "ONE_HOUR" | "SIX_HOURS";
  };
};

type SecurityBaselineConfig = AwsConfig & {
  securityBaseline?: {
    stackSets: Array<{
      name: string;
      templateKey: string;
      targets: string[];
      parameters: Array<{ key: string; value: string }>;
    }>;
  };
};
```

## What `withSecurityBaseline()` does

Pure function that enhances the user config:

1. **Adds `delegatedAdministrators`** entries for referenced accounts (CloudTrail, Config, GuardDuty service principals) — only if not already present
2. **Records StackSet metadata** in `securityBaseline.stackSets` field
3. **Validates** referenced account names exist in the config (runtime assertion)
4. **Does NOT** modify `organizationalUnits`, `permissionSets`, or `policies`

## StackSet Templates

### Shipped as static assets

```
@beesolve/aws-accounts/
├── templates/
│   ├── config-recorder.yaml
│   └── guardduty-member.yaml
```

### `templates/config-recorder.yaml`

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: "AWS Config recorder and delivery channel"
Parameters:
  DeliveryBucketName:
    Type: String
  AllSupported:
    Type: String
    Default: "true"
    AllowedValues: ["true", "false"]
  IncludeGlobalResourceTypes:
    Type: String
    Default: "true"
    AllowedValues: ["true", "false"]
  DeliveryFrequency:
    Type: String
    Default: "TwentyFour_Hours"
    AllowedValues: [One_Hour, Three_Hours, Six_Hours, Twelve_Hours, TwentyFour_Hours]
Resources:
  ConfigRecorder:
    Type: AWS::Config::ConfigurationRecorder
    Properties:
      RoleARN: !Sub "arn:aws:iam::${AWS::AccountId}:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig"
      RecordingGroup:
        AllSupported: !Ref AllSupported
        IncludeGlobalResourceTypes: !Ref IncludeGlobalResourceTypes
  DeliveryChannel:
    Type: AWS::Config::DeliveryChannel
    Properties:
      S3BucketName: !Ref DeliveryBucketName
      ConfigSnapshotDeliveryProperties:
        DeliveryFrequency: !Ref DeliveryFrequency
```

### `templates/guardduty-member.yaml`

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: "GuardDuty detector for member accounts"
Parameters:
  FindingPublishingFrequency:
    Type: String
    Default: "FIFTEEN_MINUTES"
    AllowedValues: [FIFTEEN_MINUTES, ONE_HOUR, SIX_HOURS]
Resources:
  Detector:
    Type: AWS::GuardDuty::Detector
    Properties:
      Enable: true
      FindingPublishingFrequency: !Ref FindingPublishingFrequency
```

### User override mechanism

```bash
npx aws-accounts config reveal
```

Copies default templates to `./templates/` in the user's project. The tool resolves templates as:
1. Check `./templates/<key>.yaml` (user override)
2. Fall back to package default `templates/<key>.yaml`

## Template Delivery to Lambda

Same presigned URL flow as existing state management:

1. CLI calls Lambda `{ action: "getUploadUrl", key: "templates/config-recorder.yaml" }`
2. Lambda returns presigned S3 PUT URL
3. CLI uploads template YAML to S3
4. CLI calls Lambda `{ action: "deployStackSet", stackSetName: "...", templateS3Key: "...", ... }`
5. Lambda reads template from S3, calls CloudFormation StackSets API

## New Lambda Actions

```typescript
const getUploadUrlRequestSchema = v.strictObject({
  action: v.literal("getUploadUrl"),
  key: v.string(),
});

const deployStackSetRequestSchema = v.strictObject({
  action: v.literal("deployStackSet"),
  stackSetName: v.string(),
  templateS3Key: v.string(),
  targets: v.array(v.string()),       // resolved OU IDs
  parameters: v.array(v.strictObject({
    key: v.string(),
    value: v.string(),
  })),
  regions: v.array(v.string()),
});
```

## Plan/Apply Integration

After diffing standard config, the plan also diffs StackSets:

```
Plan: 5 operation(s)
  create account "LogArchive" in OU "Security"
  create account "SecurityAudit" in OU "Security"
  register delegated admin "SecurityAudit" for cloudtrail.amazonaws.com
  [stackset] create "SecurityBaseline-ConfigRecorder" targeting root (eu-central-1)
  [stackset] create "SecurityBaseline-GuardDuty" targeting root (eu-central-1)
```

## New CLI Command

### `npx aws-accounts config reveal`

```
$ npx aws-accounts config reveal
Copied templates/config-recorder.yaml → ./templates/config-recorder.yaml
Copied templates/guardduty-member.yaml → ./templates/guardduty-member.yaml
Edit these files to customize. Local copies take precedence over package defaults.
```

## Task Breakdown

### Task 1: Rename `policies.ts` → `security.ts`, update exports
- Rename file
- Update `package.json` exports: `"./security"` replaces `"./policies"`
- Keep `"./policies"` as deprecated alias pointing to same file
- Update all internal imports and tests
- Update generated types codegen to import from new path

### Task 2: Implement `withSecurityBaseline()` function
- Define `SecurityBaselineOptions<T, A>` and `SecurityBaselineConfig` types
- Implement config enhancement logic (add delegated admins, record StackSet metadata)
- Validate referenced account names exist in config
- Unit tests

### Task 3: Extend `AwsConfigModel` with optional `securityBaseline` field
- Add to schema (optional, not required for existing users)
- Update `mapAwsConfigToState` to handle StackSet declarations
- Update state schema with StackSet state tracking
- Update diff logic to detect StackSet changes

### Task 4: Create default CloudFormation templates
- `templates/config-recorder.yaml`
- `templates/guardduty-member.yaml`
- Add `"templates"` to `files` array in `package.json`
- Template resolution helper (user override > package default)

### Task 5: Implement `config reveal` CLI command
- New command in `src/commands/`
- Copies templates from package to `./templates/`
- Register in CLI dispatcher

### Task 6: Add `getUploadUrl` Lambda action
- New handler branch for presigned PUT URLs
- CLI uploads template content to S3 via presigned URL

### Task 7: Add `deployStackSet` Lambda action
- Lambda handler: `CreateStackSet` / `UpdateStackSet` + `CreateStackInstances`
- Uses service-managed permissions (Organizations integration)
- Handles idempotency (update if exists, create if not)

### Task 8: Add StackSet operation types to plan/apply
- New operation kinds: `createStackSet`, `updateStackSet`, `deleteStackSet`
- Diff logic: compare desired vs deployed StackSets
- Apply flow: upload template → invoke `deployStackSet`
- State tracking for deployed StackSets

### Task 9: Extend Lambda IAM role permissions
- Add to bootstrap: `cloudformation:Create*StackSet*`, `cloudformation:Update*`, `cloudformation:Delete*`, `cloudformation:Describe*`, `cloudformation:List*`
- Add Organizations permissions for service-managed StackSets

### Task 10: Update README and docs
- Document `withSecurityBaseline()` with ready-to-copy Security OU snippet
- Document `config reveal` command
- Document template override mechanism
- Document StackSet parameters

### Task 11: Integration tests
- `withSecurityBaseline` enhances config correctly
- Plan shows StackSet operations
- Template resolution (user override vs default)
- Validate command catches missing account references
