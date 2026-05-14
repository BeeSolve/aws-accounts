# Requirements Document

## Introduction

This feature enhances the existing bootstrap commands (local and remote) with consistent AWS resource tagging, IAM Identity Center permission set creation during remote bootstrap, automatic type regeneration after remote apply, and a mechanism to address code review TODO comments from the remote-execution-v2 implementation. The goal is to improve operational visibility of bootstrapped resources in the AWS Console, provide ready-to-use permission sets for organization management, keep type definitions in sync automatically, and ensure code quality improvements are tracked and completed.

## Glossary

- **Bootstrap_Command**: The local bootstrap command (`aws-accounts bootstrap`) that discovers the AWS Organization, creates the Graveyard OU, captures Identity Center metadata, and writes `aws.context.json`
- **Remote_Bootstrap_Command**: The remote bootstrap command (`aws-accounts remote bootstrap`) that creates the S3 bucket, IAM role, and Lambda function for remote execution
- **Resource_Tag**: An AWS tag (key-value pair) applied to a resource for identification and filtering
- **Standard_Tag_Set**: The consistent set of tags applied to all resources created by bootstrap commands, including `ManagedBy: beesolve-aws-accounts` and `Purpose` tags
- **Permission_Set**: An IAM Identity Center permission set that defines a collection of IAM policies to assign to users or groups
- **OrganizationManagement_Permission_Set**: A permission set with broad permissions for managing the AWS Organization and IAM Identity Center
- **OrganizationRemoteManagement_Permission_Set**: A permission set with minimal permissions to invoke the remote Lambda function
- **TODO_Comment**: A code comment in the format `// TODO:` left during code review of the remote-execution-v2 implementation indicating a required improvement
- **Type_Regeneration**: The process of regenerating `aws.config.types.ts` from the current state, equivalent to running `aws-accounts regenerate`

## Requirements

### Requirement 1: Resource Tagging for Remote Bootstrap

**User Story:** As a DevOps engineer, I want all AWS resources created during remote bootstrap to be tagged with consistent identifiers, so that I can easily find and manage these resources in the AWS Console.

#### Acceptance Criteria

1. WHEN the Remote_Bootstrap_Command creates an S3 bucket, THE Remote_Bootstrap_Command SHALL apply the Standard_Tag_Set to the bucket
2. WHEN the Remote_Bootstrap_Command creates an IAM role, THE Remote_Bootstrap_Command SHALL apply the Standard_Tag_Set to the role
3. WHEN the Remote_Bootstrap_Command creates a Lambda function, THE Remote_Bootstrap_Command SHALL apply the Standard_Tag_Set to the function
4. THE Standard_Tag_Set SHALL include a `ManagedBy` tag with value `beesolve-aws-accounts`
5. THE Standard_Tag_Set SHALL include a `Purpose` tag with the following values per resource: `state-storage` for the S3 bucket, `execution-role` for the IAM role, `remote-execution` for the Lambda function
6. WHEN the Remote_Bootstrap_Command updates an existing resource (idempotent re-run), THE Remote_Bootstrap_Command SHALL ensure the Standard_Tag_Set is present on the resource
7. IF the AWS tagging API call fails for a resource, THEN THE Remote_Bootstrap_Command SHALL propagate the error and halt bootstrap execution

### Requirement 2: Resource Tagging for Local Bootstrap and All Managed Resources

**User Story:** As a DevOps engineer, I want all supporting resources created or managed by the tool (across both local and remote bootstrap) to be tagged consistently, so that I can identify tool-managed resources across the organization.

#### Acceptance Criteria

1. WHEN the Bootstrap_Command creates the Graveyard organizational unit, THE Bootstrap_Command SHALL apply the Standard_Tag_Set to the organizational unit with `Purpose` tag value `graveyard`
2. THE Standard_Tag_Set applied to the Graveyard OU SHALL include a `ManagedBy` tag with value `beesolve-aws-accounts` and a `Purpose` tag with value `graveyard`
3. IF the Bootstrap_Command runs and the Graveyard OU already exists, THEN THE Bootstrap_Command SHALL apply the Standard_Tag_Set to the existing Graveyard OU, overwriting any existing values for the `ManagedBy` and `Purpose` tag keys
4. WHEN any bootstrap command (local or remote) creates or manages a supporting resource, THE bootstrap command SHALL apply the Standard_Tag_Set to that resource
5. THE Standard_Tag_Set SHALL only be applied to supporting infrastructure resources managed by the tool (Graveyard OU, S3 state bucket, IAM execution role, Lambda function, permission sets), not to resources created on behalf of the user through plan/apply operations
6. IF applying the Standard_Tag_Set to a resource fails due to an AWS API error, THEN THE bootstrap command SHALL propagate the error and halt execution without completing the bootstrap operation

### Requirement 3: Permission Set Creation During Remote Bootstrap

**User Story:** As an organization administrator, I want the remote bootstrap to create standard permission sets for organization management, so that I can immediately assign appropriate access levels to team members.

#### Acceptance Criteria

1. WHEN the Remote_Bootstrap_Command completes resource creation, THE Remote_Bootstrap_Command SHALL create an IAM Identity Center permission set named `OrganizationManagement` with a session duration of 4 hours
2. THE OrganizationManagement_Permission_Set SHALL include an inline policy granting `organizations:*`, `sso:*`, `identitystore:*`, `account:*`, and `iam:*` actions on all resources (Resource: `*`)
3. THE OrganizationManagement_Permission_Set SHALL have a description indicating it provides full organization management access
4. WHEN the Remote_Bootstrap_Command completes resource creation, THE Remote_Bootstrap_Command SHALL create an IAM Identity Center permission set named `OrganizationRemoteManagement` with a session duration of 1 hour
5. THE OrganizationRemoteManagement_Permission_Set SHALL include an inline policy granting only `lambda:InvokeFunction` permission with the resource scoped to the deployed Lambda function ARN stored in the Context_File
6. THE OrganizationRemoteManagement_Permission_Set SHALL have a description indicating it provides minimal access to invoke the remote management Lambda
7. WHEN the Remote_Bootstrap_Command runs and one or both permission sets already exist, THE Remote_Bootstrap_Command SHALL update the existing permission sets' inline policies to match the current expected configuration without recreating them
8. WHEN the Remote_Bootstrap_Command creates or updates permission sets, THE Remote_Bootstrap_Command SHALL apply the Standard_Tag_Set to both permission sets with `Purpose` tag values of `organization-management` and `remote-invocation` respectively
9. IF the Context_File does not contain an `identityCenter` entry (instance ARN and identity store ID) during remote bootstrap, THEN THE Remote_Bootstrap_Command SHALL skip permission set creation and log a warning message indicating that IAM Identity Center is not configured
10. IF permission set creation fails for one permission set, THEN THE Remote_Bootstrap_Command SHALL report the failure for that permission set and continue attempting to create or update the remaining permission set

### Requirement 4: Tag Definition Centralization

**User Story:** As a developer, I want tag definitions to be centralized in a single module, so that tag values remain consistent across all bootstrap operations.

#### Acceptance Criteria

1. THE tag definition module SHALL export a function that accepts a `purpose` string parameter (maximum 64 characters, non-empty) and returns the Standard_Tag_Set as an array of `{ Key: string; Value: string }` objects compatible with the AWS SDK tag format
2. THE tag definition module SHALL define the `ManagedBy` tag key with the constant value `beesolve-aws-accounts` as an exported constant
3. WHEN the tag generation function is called with a `purpose` parameter, THE function SHALL return a tag set containing exactly two tags: a `ManagedBy` tag with the constant value and a `Purpose` tag with the provided `purpose` string as its value
4. WHEN any bootstrap command (Bootstrap_Command or Remote_Bootstrap_Command) needs to apply tags, THE bootstrap command SHALL import and call the centralized tag generation function rather than constructing tag key-value pairs inline
5. IF the `purpose` parameter is an empty string, THEN THE tag definition module SHALL throw an error indicating that a non-empty purpose is required

### Requirement 6: Automatic Type Regeneration After Remote Apply

**User Story:** As a DevOps engineer, I want the CLI to automatically regenerate `aws.config.types.ts` after a successful remote apply, so that my type definitions stay in sync with the current state without requiring a manual `regenerate` step.

#### Acceptance Criteria

1. WHEN `aws-accounts remote apply` completes successfully (all operations applied), THE CLI SHALL automatically run the type regeneration logic (equivalent to `aws-accounts regenerate`)
2. THE automatic regeneration SHALL use the updated state returned from the Lambda apply response as the basis for type generation
3. WHEN the regeneration produces changes to `aws.config.types.ts`, THE CLI SHALL log a message indicating the types file was updated
4. WHEN the regeneration produces no changes to `aws.config.types.ts`, THE CLI SHALL not log any regeneration-related message
5. IF the automatic regeneration fails (e.g., file write error), THEN THE CLI SHALL log a warning but SHALL NOT treat the apply as failed — the apply itself already succeeded

### Requirement 7: Code Review TODO Resolution

**User Story:** As a developer, I want all TODO comments from the remote-execution-v2 code review to be tracked and resolved, so that the codebase maintains high quality after the initial implementation.

#### Acceptance Criteria

1. WHEN generating the implementation task list, THE task list SHALL include one task for each `// TODO` comment found in TypeScript source files under `src/` that was added during the remote-execution-v2 code review
2. THE task list SHALL group TODO-related tasks by the source file path they appear in
3. WHEN the implementation task addressing a TODO comment is completed, THE implementation SHALL remove the corresponding `// TODO` comment from the source code
4. THE task list SHALL preserve the original TODO comment text as the task description so the intent of the requested change is visible without reading the source file

> **Note:** This requirement will be fully specified after the user completes their code review and adds TODO comments to the codebase. The task list generation should be deferred until those TODOs are in place.
