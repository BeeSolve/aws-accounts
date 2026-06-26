# Implementation Plan — Root Access Management & Password Policy

## Problem Statement

Enable centralized root access management (delete root credentials from member accounts) and deploy organization-wide IAM password policies via StackSets.

## Background

AWS Organizations supports **Centralized Root Access Management** (since late 2024):

- `iam:EnableOrganizationsRootCredentialsManagement` — allows management account or delegated admin to delete root user credentials from member accounts
- `iam:EnableOrganizationsRootSessions` — allows privileged root actions via `sts:AssumeRoot` without needing root password
- New accounts created after enabling this feature have **no root credentials by default**
- Requires `organizations:EnableAWSServiceAccess` for `iam.amazonaws.com`

These are one-time org-level API calls. Once enabled, the management account (or IAM delegated admin) can manage root credentials across all member accounts.

## What's Already Implemented

- `scp.denyRootWithoutMfa()` — SCP pattern that denies all root actions without MFA
- `withSecurityBaseline({ rootAccessManagement: { enabled: true, delegatedAdminAccount: "..." } })` — registers `iam.amazonaws.com` delegated admin

## What's Missing

### 1. Lambda action to enable root access management

A new Lambda action `enableRootAccessManagement` that calls:

1. `organizations:EnableAWSServiceAccess` with `ServicePrincipal: "iam.amazonaws.com"`
2. `iam:EnableOrganizationsRootCredentialsManagement`
3. `iam:EnableOrganizationsRootSessions`

These are idempotent — safe to call multiple times.

### 2. Integration into plan/apply

When `rootAccessManagement.enabled` is true in the security baseline config, the plan should show and execute the enablement API calls (similar to how StackSet operations work — a separate phase after standard operations).

### 3. IAM Password Policy StackSet

A new CloudFormation template `templates/iam-password-policy.yaml` that deploys a custom IAM password policy per account.

### 4. `withSecurityBaseline` password policy option

```typescript
passwordPolicy?: {
  enabled: boolean;
  targets: T[];
  minimumPasswordLength?: number;      // default: 14
  requireSymbols?: boolean;            // default: true
  requireNumbers?: boolean;            // default: true
  requireUppercaseCharacters?: boolean; // default: true
  requireLowercaseCharacters?: boolean; // default: true
  maxPasswordAge?: number;             // default: 90 (days)
  passwordReusePrevention?: number;    // default: 24
  allowUsersToChangePassword?: boolean; // default: true
};
```

## Task Breakdown

### Task 1: Create `templates/iam-password-policy.yaml`

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: "IAM password policy for organization member accounts"
Parameters:
  MinimumPasswordLength:
    Type: Number
    Default: 14
  RequireSymbols:
    Type: String
    Default: "true"
    AllowedValues: ["true", "false"]
  RequireNumbers:
    Type: String
    Default: "true"
    AllowedValues: ["true", "false"]
  RequireUppercaseCharacters:
    Type: String
    Default: "true"
    AllowedValues: ["true", "false"]
  RequireLowercaseCharacters:
    Type: String
    Default: "true"
    AllowedValues: ["true", "false"]
  MaxPasswordAge:
    Type: Number
    Default: 90
  PasswordReusePrevention:
    Type: Number
    Default: 24
  AllowUsersToChangePassword:
    Type: String
    Default: "true"
    AllowedValues: ["true", "false"]
Resources:
  PasswordPolicy:
    Type: Custom::PasswordPolicy
    # Note: AWS CloudFormation does not have a native IAM password policy resource.
    # This requires a Lambda-backed custom resource OR use AWS::IAM::AccountPasswordPolicy
    # (available in some regions). Alternative: deploy via CLI in the StackSet.
```

**Open question:** `AWS::IAM::AccountPasswordPolicy` is not a standard CloudFormation resource. Options:

- a. Use a Lambda-backed custom resource in the StackSet template
- b. Handle password policy as a direct API call from the remote Lambda (like root access management) via `iam:UpdateAccountPasswordPolicy` called per-account through role assumption
- c. Use AWS Config managed rule to detect non-compliant password policies + auto-remediation

**Recommendation:** Option (b) — direct API call via `sts:AssumeRole` into each member account. This avoids custom resource complexity and is consistent with how other org-level operations work.

### Task 2: Add `enableRootAccessManagement` Lambda action

- New request schema: `{ action: "enableRootAccessManagement" }`
- Handler calls the 3 IAM/Organizations APIs
- Add required IAM permissions to Lambda role:
  - `organizations:EnableAWSServiceAccess`
  - `iam:EnableOrganizationsRootCredentialsManagement`
  - `iam:EnableOrganizationsRootSessions`

### Task 3: Add root access management to plan/apply flow

- When `rootAccessManagement.enabled`, add an operation to the plan
- Execute during apply after standard operations, before StackSets
- Idempotent — safe to re-run

### Task 4: Add `passwordPolicy` to `withSecurityBaseline` options

- Add the type to `SecurityBaselineOptions`
- Produce a StackSet declaration (or direct API operation depending on chosen approach)
- Add `"iam-password-policy"` to the valid stackset names picklist

### Task 5: Update `config reveal` to include new template

- Add `iam-password-policy.yaml` to the template list
- Update the valid stackset names in handler/lambdaClient schemas

### Task 6: Tests

- Test `enableRootAccessManagement` produces correct delegated admin
- Test password policy option produces correct parameters
- Test template file exists

## Dependencies

- Task 1 depends on architecture decision (a, b, or c above)
- Tasks 2-3 can proceed independently
- Tasks 4-5 depend on Task 1 decision
- Task 6 depends on all

## Notes

- The `scp.denyRootWithoutMfa()` pattern is complementary — it's useful even with centralized root access enabled (defense in depth for management account)
- Root access management is a one-time enablement, not per-account. Once enabled, it applies to all current and future member accounts automatically.
- Password policy is per-account and needs to be deployed to each account individually.
