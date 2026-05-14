# Implementation Plan: Bootstrap Enhancements

## Overview

This plan implements consistent AWS resource tagging, permission set creation during remote bootstrap, automatic type regeneration after remote apply, and resolves all code review TODO comments. Tasks are ordered so that foundational modules (tags, helpers) come first, followed by feature additions, then refactoring grouped by file.

## Tasks

- [ ] 1. Create tag module and property tests
  - [ ] 1.1 Create `src/tags.ts` with `getStandardTags` function and `MANAGED_BY_TAG_VALUE` constant
    - Export `MANAGED_BY_TAG_VALUE = "beesolve-aws-accounts"`
    - Export `AwsTag` type as `{ Key: string; Value: string }`
    - Implement `getStandardTags(purpose: string): AwsTag[]` that returns `[{ Key: "ManagedBy", Value: MANAGED_BY_TAG_VALUE }, { Key: "Purpose", Value: purpose }]`
    - Throw an Error if `purpose` is empty string
    - _Requirements: 4.1, 4.2, 4.3, 4.5_

  - [ ]* 1.2 Write property test for tag generation correctness
    - **Property 1: Tag generation produces correct structure and content**
    - Use `fast-check` to generate random non-empty strings (1–64 chars) and verify `getStandardTags` returns exactly 2 elements with correct keys and values
    - **Validates: Requirements 1.4, 4.1, 4.3**

  - [ ]* 1.3 Write property test for empty purpose rejection
    - **Property 2: Empty purpose string is rejected**
    - Verify `getStandardTags("")` throws an Error
    - **Validates: Requirements 4.5**

- [ ] 2. Add tagging to remote bootstrap
  - [ ] 2.1 Apply Standard_Tag_Set to S3 bucket in `src/commands/remote.ts`
    - Import `getStandardTags` from `../tags.js`
    - After bucket creation (or when bucket already exists), call `PutBucketTagging` with `getStandardTags("state-storage")`
    - Import `PutBucketTaggingCommand` from `@aws-sdk/client-s3`
    - _Requirements: 1.1, 1.4, 1.5, 1.6, 1.7, 4.4_

  - [ ] 2.2 Apply Standard_Tag_Set to IAM role in `src/commands/remote.ts`
    - Pass `Tags` parameter with `getStandardTags("execution-role")` to `CreateRoleCommand` when creating a new role
    - When role already exists, call `TagRole` command with the standard tags
    - Import `TagRoleCommand` from `@aws-sdk/client-iam`
    - _Requirements: 1.2, 1.4, 1.5, 1.6, 1.7, 4.4_

  - [ ] 2.3 Apply Standard_Tag_Set to Lambda function in `src/commands/remote.ts`
    - Pass `Tags` parameter (as `Record<string, string>` format required by Lambda) with `getStandardTags("remote-execution")` to `CreateFunctionCommand`
    - When function already exists, call `TagResource` with the Lambda ARN and standard tags
    - Import `TagResourceCommand` from `@aws-sdk/client-lambda`
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 4.4_

  - [ ]* 2.4 Write unit tests for remote bootstrap tagging
    - Verify each resource creation/update call includes correct tags
    - Verify tags are applied when resources already exist (idempotent re-run)
    - _Requirements: 1.1, 1.2, 1.3, 1.6_

- [ ] 3. Add tagging to local bootstrap
  - [ ] 3.1 Apply Standard_Tag_Set to Graveyard OU in `src/commands/bootstrap.ts`
    - Import `getStandardTags` from `../tags.js`
    - Pass `Tags` parameter with `getStandardTags("graveyard")` to `CreateOrganizationalUnitCommand` when creating new OU
    - When Graveyard OU already exists, call `TagResourceCommand` from `@aws-sdk/client-organizations` with the OU ID and standard tags
    - Import `TagResourceCommand` from `@aws-sdk/client-organizations`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 4.4_

  - [ ]* 3.2 Write unit tests for local bootstrap tagging
    - Verify Graveyard OU creation includes tags
    - Verify existing Graveyard OU gets tagged
    - _Requirements: 2.1, 2.2, 2.3_

- [ ] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Implement permission set creation during remote bootstrap
  - [ ] 5.1 Implement `ensureOrganizationManagementPermissionSet` in `src/commands/remote.ts`
    - Create or update the `OrganizationManagement` permission set with 4-hour session duration
    - Inline policy: `organizations:*`, `sso:*`, `identitystore:*`, `account:*`, `iam:*` on `Resource: *`
    - Apply `getStandardTags("organization-management")` to the permission set
    - Use `CreatePermissionSet` / `DescribePermissionSet` + `UpdatePermissionSet` pattern
    - Use `PutInlinePolicyToPermissionSet` for the inline policy
    - Import `SSOAdminClient` and relevant commands from `@aws-sdk/client-sso-admin`
    - _Requirements: 3.1, 3.2, 3.3, 3.7, 3.8_

  - [ ] 5.2 Implement `ensureOrganizationRemoteManagementPermissionSet` in `src/commands/remote.ts`
    - Create or update the `OrganizationRemoteManagement` permission set with 1-hour session duration
    - Inline policy: `lambda:InvokeFunction` scoped to the deployed Lambda ARN
    - Apply `getStandardTags("remote-invocation")` to the permission set
    - _Requirements: 3.4, 3.5, 3.6, 3.7, 3.8_

  - [ ] 5.3 Wire permission set creation into `runRemoteBootstrap`
    - After Lambda deployment and context file write, call both `ensureOrganizationManagementPermissionSet` and `ensureOrganizationRemoteManagementPermissionSet`
    - Read `identityCenter` from context; if missing, log warning and skip permission set creation
    - If one permission set fails, log error and continue with the other
    - _Requirements: 3.9, 3.10_

  - [ ]* 5.4 Write unit tests for permission set creation
    - Verify both permission sets are created with correct configuration
    - Verify existing permission sets are updated (idempotent)
    - Verify graceful skip when Identity Center is not configured
    - Verify partial failure (one fails, other still attempted)
    - _Requirements: 3.1, 3.4, 3.7, 3.9, 3.10_

- [ ] 6. Implement automatic type regeneration after remote apply
  - [ ] 6.1 Implement `regenerateTypesFromState` helper in `src/commands/remote.ts`
    - Accept `state: StateFile`, `contextPath`, `configPath`, `typesPath`, `logger`
    - Use existing `mapStateToAwsConfig` and `renderAwsConfigTypesTs` to generate types
    - Compare with current file content; write only if changed
    - Log on change, silent on no-change
    - Catch and log errors without re-throwing (apply already succeeded)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ] 6.2 Call `regenerateTypesFromState` after successful apply in `runRemoteApply`
    - After `Applied N operation(s)` log, call regeneration with `response.state`
    - _Requirements: 6.1, 6.2_

  - [ ]* 6.3 Write unit tests for post-apply regeneration
    - Verify regeneration is called with response state on success
    - Verify warning logged on regeneration failure (apply not failed)
    - Verify no log when types unchanged
    - _Requirements: 6.3, 6.4, 6.5_

- [ ] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Resolve TODO comments in `src/lambda/handler.ts`
  - [ ] 8.1 Remove `as const` on literal booleans and `getStateUrl` response
    - Remove `as const` from `success: false as const` in `buildErrorResponse` (line 151)
    - Remove `as const` from `success: true as const` in `handleGetStateUrl` (line 311)
    - The type system already narrows these literals via the valibot schema
    - _Requirements: 7.1, 7.3, 7.4_

  - [ ] 8.2 Pass AWS clients through props in handler functions
    - Add `organizationsClient`, `ssoAdminClient`, `identityStoreClient`, `accountClient` to `handleScan` and `handleApply` props
    - Create clients in the top-level `handler` function and pass them down
    - This enables reuse across invocations and testability
    - _Requirements: 7.1, 7.3, 7.4_

  - [ ] 8.3 Parallelize scan calls with `Promise.all` in `handleScan`
    - Replace sequential `scanOrganization` + `scanIdentityCenter` with `Promise.all([scanOrganization(...), scanIdentityCenter(...)])`
    - _Requirements: 7.1, 7.3, 7.4_

  - [ ] 8.4 Use `assertUnreachable` pattern in action routing switch
    - Replace the `switch` statement in the main `handler` function with if/else + `assertUnreachable` on the action field
    - Import or create `assertUnreachable` helper in `src/helpers.ts`
    - _Requirements: 7.1, 7.3, 7.4_

- [ ] 9. Resolve TODO comments in `src/commands/remote.ts`
  - [ ] 9.1 Infer `RemoteCommandInput` type from valibot schema
    - Replace the manually-defined `RemoteCommandInput` type with `v.InferOutput<typeof remoteCommandSchema>` or equivalent valibot inference
    - _Requirements: 7.1, 7.3, 7.4_

  - [ ] 9.2 Extract lambda zip reading to a helper function
    - Create a helper (e.g., `readLambdaZip(): Promise<Buffer>`) to avoid the `let lambdaZip` pattern
    - Reuse in both `runRemoteBootstrap` and `runRemoteUpgrade`
    - _Requirements: 7.1, 7.3, 7.4_

  - [ ] 9.3 Pass AWS clients as props in remote command functions
    - Refactor `runRemoteBootstrap`, `runRemoteInit`, `runRemoteUpgrade` to accept AWS clients via props instead of creating them internally
    - Update call sites in `src/cli.ts` to pass clients
    - _Requirements: 7.1, 7.3, 7.4_

  - [ ] 9.4 Remove `as any` cast on `CreateBucketCommand` input
    - The commented-out `as any` pattern is already replaced with proper `BucketLocationConstraint` typing; remove the commented code
    - _Requirements: 7.1, 7.3, 7.4_

  - [ ] 9.5 Parallelize context/config loading with `Promise.all` in `runRemotePlan` and `runRemoteApply`
    - Replace sequential `readAwsContextFromFile` + `loadAwsConfigModelFromTsFile` with `Promise.all`
    - _Requirements: 7.1, 7.3, 7.4_

  - [ ] 9.6 Use `assertUnreachable` pattern for operation formatting in `formatOperationLine`
    - Replace the final `const _exhaustive: never = operation` with a call to `assertUnreachable(operation)`
    - _Requirements: 7.1, 7.3, 7.4_

  - [ ] 9.7 Do not extract properties from props in `ensureLambdaFunction`
    - Remove the destructuring `const { lambdaClient, roleArn, ... } = props` and use `props.*` directly
    - _Requirements: 7.1, 7.3, 7.4_

- [ ] 10. Resolve TODO comments in `src/lambdaClient.ts`
  - [ ] 10.1 Refactor `let rawResponse` pattern to avoid `let`
    - Use early-return or IIFE pattern to eliminate the `let rawResponse: InvokeCommandOutput` declaration
    - _Requirements: 7.1, 7.3, 7.4_

  - [ ] 10.2 Refactor `let parsed` pattern to avoid `let`
    - Use early-return or IIFE pattern to eliminate the `let parsed: unknown` declaration
    - _Requirements: 7.1, 7.3, 7.4_

  - [ ] 10.3 Use `assertUnreachable` pattern for error kind mapping
    - Replace the `switch` on `errorKind` with if/else + `assertUnreachable`
    - _Requirements: 7.1, 7.3, 7.4_

- [ ] 11. Resolve TODO comments in `src/cli.ts` and `src/awsConfig.ts`
  - [ ] 11.1 Use `assertUnreachable` pattern for remote subcommands in `src/cli.ts`
    - Replace the `switch (remoteSubcommand)` with if/else + `assertUnreachable`
    - _Requirements: 7.1, 7.3, 7.4_

  - [ ] 11.2 Remove unnecessary `await` in `readAwsContextFromFile` in `src/awsConfig.ts`
    - Change `return await readAwsContextFile(path)` to `return readAwsContextFile(path)`
    - _Requirements: 7.1, 7.3, 7.4_

- [ ] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All TODO resolutions are pure refactoring — no behavioral changes
- The `assertUnreachable` helper should be created once in `src/helpers.ts` and reused across all files
- Existing tests must continue passing after each refactoring task

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1", "2.2", "2.3", "3.1"] },
    { "id": 2, "tasks": ["2.4", "3.2", "5.1", "5.2"] },
    { "id": 3, "tasks": ["5.3", "5.4", "6.1"] },
    { "id": 4, "tasks": ["6.2", "6.3"] },
    { "id": 5, "tasks": ["8.1", "8.2", "9.1", "9.2", "9.4", "9.5", "9.7", "10.1", "10.2", "11.2"] },
    { "id": 6, "tasks": ["8.3", "8.4", "9.3", "9.6", "10.3", "11.1"] }
  ]
}
```
