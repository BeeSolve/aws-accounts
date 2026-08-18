# Implementation Plan: Towards The Cloud SCP Collection

## Overview

Implement a reusable SCP collection module (`src/scpCollection.ts`) based on the TowardsTheCloud 28 production-ready SCP examples. The module exports a `toScpCollection<T, A>()` factory function returning SCP rule functions organized by OU category (foundation, security, production, development, sandbox, suspended, infrastructure, modern). Each function accepts a typed options object and returns a `PolicyEntry<T>`. Companion test files validate correctness through example-based and property-based tests.

## Tasks

- [x] 1. Set up module structure and shared types
  - [x] 1.1 Create `src/scpCollection.ts` with the factory function skeleton and shared types
    - Define and export `toScpCollection<T extends string, A extends string>()` function
    - Define `PolicyEntry<T>` type (or import if re-exported from security.ts)
    - Define shared option interfaces: `BaseOptions<T>`, `ExemptRolesOptionalOptions<T>`, `ExemptRolesRequiredOptions<T>`
    - Define all category-specific option interfaces from the design
    - Implement internal helpers: `buildExemptRolesCondition(roles)` and `buildPolicyDocument(statements)`
    - Return object with all 8 category keys, each mapping to stub functions that throw "not implemented"
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 2. Implement foundation SCPs
  - [x] 2.1 Implement `foundation.denyRootUser`
    - Single Deny statement: Action `*`, Resource `*`, Condition `StringLike` on `aws:PrincipalArn` matching `arn:aws:iam::*:root`
    - Support optional `targets` (default `["root"]`) and `name` (default `"DenyRootUser"`)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 2.2 Implement `foundation.denyUnsupportedRegions`
    - Deny with `NotAction` for global services, `StringNotEquals` condition on `aws:RequestedRegion`
    - Validate `allowedRegions` is non-empty (throw on empty)
    - Support optional `exemptRoles` via `buildExemptRolesCondition`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 2.3 Implement `foundation.enforceS3BucketOwnerEnforced`
    - Deny `s3:CreateBucket` conditioned on `s3:x-amz-object-ownership` not equaling `"BucketOwnerEnforced"`
    - Support optional `targets` and `name` (default `"EnforceS3BucketOwnerEnforced"`)
    - _Requirements: 4.1, 4.2_

  - [x] 2.4 Implement `foundation.preventLeavingOrganization`
    - Deny `organizations:LeaveOrganization`, Resource `*`, no Condition
    - Support optional `targets` (default `["root"]`) and `name` (default `"PreventLeavingOrganization"`)
    - _Requirements: 5.1, 5.2_

  - [x] 2.5 Implement `foundation.denyIamUserCreation`
    - Deny actions `iam:CreateUser`, `iam:CreateAccessKey`, Resource `*`
    - Support optional `exemptRoles`, `targets`, `name` (default `"DenyIamUserCreation"`)
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 2.6 Implement `foundation.preventDisablingEbsEncryption`
    - Deny `ec2:DisableEbsEncryptionByDefault`, Resource `*`
    - Support optional `targets` (default `["root"]`) and `name` (default `"PreventDisablingEbsEncryption"`)
    - _Requirements: 7.1, 7.2, 7.3_

  - [x] 2.7 Implement `foundation.protectPasswordPolicy`
    - Deny `iam:DeleteAccountPasswordPolicy`, `iam:UpdateAccountPasswordPolicy`, Resource `*`
    - Require `exemptRoles` (throw on empty), apply `StringNotLike` condition
    - Support optional `targets` and `name` (default `"ProtectPasswordPolicy"`)
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 2.8 Implement `foundation.enforceDataPerimeter`
    - Deny with `StringNotEqualsIfExists` on `aws:PrincipalOrgID`, `BoolIfExists` on `aws:PrincipalIsAWSService`, and service-linked role exemption via `StringNotLike`
    - Require `organizationId` (throw on missing/empty)
    - Support optional `exemptRoles`, `targets`, `name`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 3. Implement security OU SCPs
  - [x] 3.1 Implement `security.protectSecurityServicesComprehensive`
    - Deny destructive actions for CloudTrail, Config, GuardDuty, and Security Hub
    - Require `exemptRoles` (throw on empty), apply `StringNotLike` condition
    - Support optional `targets` and `name` (default `"ProtectSecurityServicesComprehensive"`)
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 3.2 Implement `security.protectSecurityHubConfig`
    - Deny Security Hub configuration-weakening actions
    - Require `exemptRoles` (throw on empty), apply `StringNotLike` condition
    - Support optional `targets` and `name` (default `"ProtectSecurityHubConfig"`)
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [x] 3.3 Implement `security.restrictToSecurityOperations`
    - Deny workload-deployment actions: `ec2:RunInstances`, `rds:CreateDBInstance`, `lambda:CreateFunction`, `ecs:CreateCluster`, `eks:CreateCluster`
    - Support optional `targets` (default `["root"]`) and `name` (default `"RestrictToSecurityOperations"`)
    - _Requirements: 12.1, 12.2, 12.3_

  - [x] 3.4 Implement `security.enforceMfaForIam`
    - Deny sensitive IAM operations with `BoolIfExists` condition on `aws:MultiFactorAuthPresent`
    - Support optional `exemptRoles`, `targets`, `name` (default `"EnforceMfaForIam"`)
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

- [x] 4. Implement production OU SCPs
  - [x] 4.1 Implement `production.enforceEncryption`
    - Three Deny statements: S3 unencrypted upload, EC2 unencrypted volume, RDS unencrypted instance
    - Support optional `targets` and `name` (default `"EnforceEncryption"`)
    - _Requirements: 14.1, 14.2, 14.3, 14.4_

  - [x] 4.2 Implement `production.preventUnauthorizedTermination`
    - Deny `ec2:TerminateInstances`, `rds:DeleteDBInstance`, `dynamodb:DeleteTable`
    - Require `approvedRoles` (throw on empty), apply `StringNotLike` condition
    - Support optional `targets` and `name` (default `"PreventUnauthorizedTermination"`)
    - _Requirements: 15.1, 15.2, 15.3, 15.4_

  - [x] 4.3 Implement `production.protectTaggedStacks`
    - Deny CloudFormation delete actions conditioned on `aws:ResourceTag/{tagKey}` matching `organizationTagValue`
    - Require both `exemptRoles` (non-empty) and `organizationTagValue` (non-empty string)
    - Support optional `tagKey` (default `"organization"`), `targets`, `name`
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6_

  - [x] 4.4 Implement `production.enforceImdsV2`
    - Deny `ec2:RunInstances` on `arn:aws:ec2:*:*:instance/*` conditioned on `ec2:MetadataHttpTokens` not equaling `"required"`
    - Support optional `targets` and `name` (default `"EnforceIMDSv2"`)
    - _Requirements: 17.1, 17.2_

- [x] 5. Implement development OU SCPs
  - [x] 5.1 Implement `development.preventExpensiveInstances`
    - Deny EC2 instances not in allowed types, RDS instances not in allowed classes, io2 volumes, NAT gateways
    - Provide sensible defaults for allowed types; support `denyNatGateway` and `denyIo2Volumes` booleans
    - Support optional `targets` and `name` (default `"PreventExpensiveInstances"`)
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5_

  - [x] 5.2 Implement `development.blockReservedPurchases`
    - Deny all reserved instance and savings plan purchase actions
    - Support optional `targets` and `name` (default `"BlockReservedPurchases"`)
    - _Requirements: 19.1, 19.2_

  - [x] 5.3 Implement `development.preventExpensiveAiMl`
    - Deny expensive AI/ML service actions (SageMaker, EMR, Redshift)
    - Support optional `targets` and `name` (default `"PreventExpensiveAiMl"`)
    - _Requirements: 20.1, 20.2_

  - [x] 5.4 Implement `development.enforceResourceTagging`
    - Deny `ec2:RunInstances`, `rds:CreateDBInstance` conditioned on `Null` check for `aws:RequestTag/<key>`
    - Default `requiredTags` to `["Environment", "Owner"]`; throw on empty array
    - Support optional `targets` and `name` (default `"EnforceResourceTagging"`)
    - _Requirements: 21.1, 21.2, 21.3, 21.4_

- [x] 6. Implement sandbox, suspended, infrastructure, and modern SCPs
  - [x] 6.1 Implement `sandbox.restrictToBasicServices`
    - Deny with NotAction for allowed services, Deny expensive EC2 instance types, Deny network connectivity actions
    - Support optional `allowedServices`, `allowedInstanceTypes`, `targets`, `name` (default `"RestrictToBasicServices"`)
    - _Requirements: 22.1, 22.2, 22.3, 22.4_

  - [x] 6.2 Implement `sandbox.preventExternalSharing`
    - Deny RAM sharing actions, Resource `*`
    - Support optional `targets` and `name` (default `"PreventExternalSharing"`)
    - _Requirements: 23.1, 23.2_

  - [x] 6.3 Implement `suspended.completeLockdown`
    - Deny `*` on `*` with `StringNotLike` condition exempting provided roles
    - Require `exemptRoles` (throw on empty)
    - Support optional `targets` and `name` (default `"SuspendedAccountLockdown"`)
    - _Requirements: 24.1, 24.2, 24.3_

  - [x] 6.4 Implement `infrastructure.restrictToNetworking`
    - Deny with NotAction for networking services; explicit Deny for compute/storage/lambda/container services
    - Support optional `targets` and `name` (default `"RestrictToNetworkingOnly"`)
    - _Requirements: 25.1, 25.2, 25.3_

  - [x] 6.5 Implement `infrastructure.protectVpcFlowLogs`
    - Deny `ec2:DeleteFlowLogs`, `logs:DeleteLogGroup`, Resource `*`
    - Support optional `exemptRoles`, `targets`, `name` (default `"ProtectVpcFlowLogs"`)
    - _Requirements: 26.1, 26.2, 26.3, 26.4_

  - [x] 6.6 Implement `modern.controlBedrockModels`
    - Deny `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` on denied model ARN patterns
    - Provide default denied model patterns; throw on empty array
    - Support optional `targets` and `name` (default `"ControlBedrockModels"`)
    - _Requirements: 27.1, 27.2, 27.3, 27.4_

  - [x] 6.7 Implement `modern.restrictQDeveloperIam`
    - Deny IAM operations conditioned on `aws:CalledViaFirst` equaling `"chatbot.amazonaws.com"`
    - Support optional `targets` and `name` (default `"RestrictQDeveloperIam"`)
    - _Requirements: 28.1, 28.2_

  - [x] 6.8 Implement `modern.requireVpcForSageMaker`
    - Deny `sagemaker:CreateNotebookInstance`, `sagemaker:CreateTrainingJob` with `Null` condition on `sagemaker:VpcSubnets`
    - Support optional `targets` and `name` (default `"RequireVpcForSageMaker"`)
    - _Requirements: 29.1, 29.2_

- [x] 7. Checkpoint - Ensure module compiles and exports correctly
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Write example-based unit tests
  - [x] 8.1 Create `src/scpCollection.test.ts` with unit tests for all SCP functions
    - Test each function returns correct default `name` value
    - Test specific deny actions match requirements (e.g., `denyRootUser` denies `*` on `*`)
    - Test `NotAction` lists contain all required global service prefixes for region restriction
    - Test multi-statement policies contain expected number of statements
    - Test boolean options (`denyNatGateway`, `denyIo2Volumes`) correctly include/omit statements
    - Test input validation throws on invalid/empty required parameters
    - Test exempt roles condition generation (present when provided, absent when empty/omitted)
    - _Requirements: 1.6, 2.1, 3.1, 3.2, 4.1, 5.1, 6.1, 7.1, 8.1, 8.3, 9.1, 9.3, 10.1, 10.4, 11.1, 12.1, 13.1, 14.1, 14.2, 14.3, 15.1, 15.3, 16.1, 16.6, 17.1, 18.1, 18.4, 19.1, 20.1, 21.1, 21.4, 22.1, 23.1, 24.1, 24.2, 25.1, 25.2, 26.1, 27.1, 27.4, 28.1, 29.1, 30.1, 30.3_

- [x] 9. Write property-based tests
  - [x] 9.1 Write property test for valid IAM policy document structure
    - **Property 1: Valid IAM policy document structure**
    - Generate random valid options for each SCP function, assert `content` contains `Version: "2012-10-17"` and non-empty `Statement` array with required fields
    - **Validates: Requirements 30.3**

  - [x] 9.2 Write property test for PolicyEntry shape consistency
    - **Property 2: PolicyEntry shape consistency**
    - For any SCP function with valid options, return value has `name` (non-empty), `description` (non-empty), `content` (object), `targets` (non-empty array)
    - **Validates: Requirements 1.2, 1.5**

  - [x] 9.3 Write property test for default targets fallback
    - **Property 3: Default targets fallback**
    - For any SCP function invoked without `targets`, returned `targets` equals `["root"]`
    - **Validates: Requirements 30.1**

  - [x] 9.4 Write property test for custom name and targets passthrough
    - **Property 4: Custom name and targets passthrough**
    - For any SCP function, when invoked with custom `name` and `targets`, returned values match exactly
    - **Validates: Requirements 2.3, 30.1**

  - [x] 9.5 Write property test for exempt roles condition generation
    - **Property 5: Exempt roles condition generation**
    - When `exemptRoles` is non-empty, every Deny statement has `StringNotLike` on `aws:PrincipalARN`; when empty/omitted, no such condition exists
    - **Validates: Requirements 30.2, 30.4, 30.5, 3.3, 3.5, 6.3, 6.4**

  - [x] 9.6 Write property test for region restriction round-trip
    - **Property 6: Region restriction round-trip**
    - For any non-empty region array, `denyUnsupportedRegions` produces `StringNotEquals` condition containing exactly those regions
    - **Validates: Requirements 3.1, 3.4**

  - [x] 9.7 Write property test for required parameter validation
    - **Property 7: Required parameter validation**
    - Functions with required non-empty arrays throw on empty input
    - **Validates: Requirements 8.3, 10.4, 15.3, 16.6, 24.2, 27.4**

  - [x] 9.8 Write property test for organization ID validation
    - **Property 8: Organization ID validation**
    - `enforceDataPerimeter` throws on empty/null/undefined `organizationId`
    - **Validates: Requirements 9.3**

  - [x] 9.9 Write property test for development instance type filtering
    - **Property 9: Development instance type filtering**
    - For any non-empty EC2 instance type array, the deny condition uses `ForAnyValue:StringNotLike` with those patterns
    - **Validates: Requirements 18.1, 18.2**

  - [x] 9.10 Write property test for tag enforcement null condition
    - **Property 10: Tag enforcement null condition**
    - For any non-empty tag key array, the Null condition contains `aws:RequestTag/<key>: "true"` for each key
    - **Validates: Requirements 21.1**

  - [x] 9.11 Write property test for SCP size constraint
    - **Property 11: SCP size constraint**
    - For any SCP function with realistic options (up to 10 roles, 5 regions), JSON serialization of `content` is under 5120 chars
    - **Validates: Requirements 30.3**

- [x] 10. Wire up module export and final checkpoint
  - [x] 10.1 Add package.json export entry for the SCP collection module
    - Add `"./scpCollection"` export mapping to `package.json` exports field
    - _Requirements: 1.1, 1.3_

  - [x] 10.2 Final checkpoint - Ensure all tests pass
    - Run `npm test` and verify all example-based and property-based tests pass
    - Run `npm run typecheck` and verify no type errors
    - Run `npm run check` and verify lint/format passes
    - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Test files are `src/scpCollection.test.ts` (unit) and `src/scpCollectionProperty.test.ts` (property)
- Uses `node --test` runner and `fast-check` for property tests (per project conventions)
- The `PolicyEntry<T>` type is the same pattern as in `src/security.ts`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "2.8"] },
    { "id": 2, "tasks": ["3.1", "3.2", "3.3", "3.4", "4.1", "4.2", "4.3", "4.4"] },
    {
      "id": 3,
      "tasks": ["5.1", "5.2", "5.3", "5.4", "6.1", "6.2", "6.3", "6.4", "6.5", "6.6", "6.7", "6.8"]
    },
    { "id": 4, "tasks": ["8.1"] },
    {
      "id": 5,
      "tasks": ["9.1", "9.2", "9.3", "9.4", "9.5", "9.6", "9.7", "9.8", "9.9", "9.10", "9.11"]
    },
    { "id": 6, "tasks": ["10.1", "10.2"] }
  ]
}
```
