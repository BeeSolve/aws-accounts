# Requirements Document

## Introduction

This feature restructures the @beesolve/aws-accounts codebase to remove the local execution model (direct AWS SDK calls from the CLI for scan, bootstrap, init, plan, apply, graveyard) and retain only the remote execution model (Lambda-based execution). Local utility commands (`regenerate` and `graveyard`) that operate purely on local files without AWS SDK calls are retained as top-level commands. The transition is done in three phases: (1) extract a complete standalone copy of the local execution code into a `local/` folder and commit it (preserving a recoverable snapshot in git history), (2) remove local-specific code from the main `src/` tree and promote remote commands to top-level while retaining local utility commands, and (3) clean up remaining code, unused dependencies, and documentation.

## Glossary

- **CLI**: The command-line interface entry point (`src/cli.ts`) that dispatches user commands
- **Local_Execution_Model**: The execution path where the CLI directly invokes AWS SDK clients to perform scan, bootstrap, init, plan, apply, and graveyard operations using a local `state.json` file, without a Lambda intermediary
- **Remote_Execution_Model**: The execution path where the CLI invokes a deployed AWS Lambda function to perform scan, plan, and apply operations, with state persisted in S3
- **Extraction_Folder**: The `local/` directory at the repository root that contains a complete, self-contained copy of the local execution code
- **ADR**: Architecture Decision Record documenting the rationale for removing the local execution model
- **Shared_Module**: A source module used by both the local and remote execution paths (e.g., `state.ts`, `diff.ts`, `operations.ts`, `helpers.ts`, `applyLogic.ts`, `scanLogic.ts`)
- **Local_Command**: A top-level CLI command that executes AWS operations directly from the user's machine: `scan`, `bootstrap`, `init`, `plan`, `apply`. Note: `regenerate` and `graveyard` are local utility commands that do not call AWS SDK — they only read/write local files (state.json, aws.context.json, aws.config.ts, aws.config.types.ts) and are retained in the remote-only codebase
- **Remote_Subcommand**: A CLI command under the `remote` namespace that delegates operations to a Lambda function: `bootstrap`, `scan`, `init`, `plan`, `apply`, `upgrade`

## Requirements

### Requirement 1: Extract Local Execution Code into Standalone Folder

**User Story:** As a developer, I want a complete standalone copy of the local execution code in a `local/` folder, so that the full local-first version is preserved in git history before removal.

#### Acceptance Criteria

1. WHEN the extraction is performed, THE Extraction_Folder SHALL be located at the repository root path `local/` and contain a fully self-contained copy of all source files needed to build and run the Local_Execution_Model independently, with no import statements referencing paths outside the `local/` directory tree
2. WHEN the extraction is performed, THE Extraction_Folder SHALL include duplicated copies of all Shared_Modules (applyLogic.ts, scanLogic.ts, state.ts, operations.ts, diff.ts, helpers.ts, awsConfig.ts, awsClientConfig.ts, error.ts, tags.ts, accountCreation.ts, reservedOuDeletion.ts, logger.ts) rather than importing from the parent codebase
3. THE Extraction_Folder SHALL contain its own `package.json` with all dependencies required to build and run the local CLI, including at minimum: @aws-sdk/client-organizations, @aws-sdk/client-sso-admin, @aws-sdk/client-identitystore, @aws-sdk/client-account, @aws-sdk/client-sts, @aws-sdk/credential-providers, @beesolve/iam-policy-ts, esbuild, valibot, typescript, and @types/node
4. THE Extraction_Folder SHALL contain its own `tsconfig.json` configured for standalone compilation with no references to the parent project's tsconfig
5. THE Extraction_Folder SHALL contain a `build` script in its `package.json` that produces a runnable CLI entry point with a non-zero exit code when invoked with an unknown command
6. THE Extraction_Folder SHALL include all Local_Command implementations: scan, bootstrap, init, regenerate, plan, apply, and graveyard
7. THE Extraction_Folder SHALL include a CLI entry point that dispatches the commands scan, bootstrap, init, regenerate, plan, apply, and graveyard, and does not register or accept a `remote` subcommand
8. THE Extraction_Folder SHALL include all test files associated with local command implementations and shared modules (excluding remote.test.ts, remote.permissionset.test.ts, remote.tagging.test.ts, and lambdaClient tests)
9. THE Extraction_Folder SHALL NOT include any remote-specific code: Lambda handler (src/lambda/handler.ts), lambdaClient.ts, remoteStateCache.ts, remote.ts command, or the buildLambda.ts script
10. WHEN the extraction is complete, THE Extraction_Folder SHALL compile without TypeScript errors when running `tsc --noEmit` using its own tsconfig
11. IF a user invokes `npm install` followed by the build script inside the Extraction_Folder, THEN THE Extraction_Folder SHALL produce a CLI that exits with code 0 when invoked with `--help`

### Requirement 2: Commit Extraction Before Removal

**User Story:** As a developer, I want the extracted local folder committed as a discrete git commit, so that there is a specific commit hash I can reference to recover the full local-first version.

#### Acceptance Criteria

1. WHEN the extraction is complete, THE developer SHALL create a git commit containing only the `local/` folder addition with no other source code modifications included in the same commit
2. THE commit message SHALL contain the phrase "preserve local execution model" and reference that the commit is intended as a recovery point for the local-first version
3. THE commit SHALL be created before any removal of local code from the main `src/` tree begins, verifiable by git log ordering
4. WHEN the commit is created, THE commit hash SHALL be recorded for inclusion in the ADR (Requirement 4)

### Requirement 3: Remove Local Execution Code from Main Codebase

**User Story:** As a developer, I want all local-specific execution code removed from the main `src/` tree, so that only the remote execution path remains as the primary interface.

#### Acceptance Criteria

1. WHEN the removal is performed, THE CLI entry point SHALL remove the Local_Commands (`scan`, `bootstrap`, `init`, `plan`, `apply`) as top-level commands that directly invoke AWS SDK operations
2. WHEN the removal is performed, THE CLI SHALL promote the Remote_Subcommands (`bootstrap`, `scan`, `init`, `plan`, `apply`, `upgrade`) to become top-level commands and SHALL retain the local utility commands (`regenerate`, `graveyard`) as top-level commands, such that the final command set is: `bootstrap`, `scan`, `init`, `regenerate`, `graveyard`, `plan`, `apply`, `upgrade`
3. WHEN the removal is performed, THE CLI SHALL remove the `remote` subcommand namespace since remote is now the only execution path for AWS operations
4. WHEN the removal is performed, THE CLI SHALL delete the local-only command source files: `src/commands/scan.ts`, `src/commands/bootstrap.ts`, `src/commands/init.ts`, `src/commands/plan.ts`, `src/commands/apply.ts` — while retaining `src/commands/regenerate.ts` and `src/commands/graveyard.ts` as they are local utility commands that do not invoke AWS SDK
5. WHEN the removal is performed, THE CLI SHALL delete the local-only test files: `src/commands/scan.test.ts`, `src/commands/bootstrap.test.ts`, `src/commands/init.test.ts`, `src/commands/plan.test.ts`, `src/commands/apply.test.ts` — while retaining `src/commands/regenerate.test.ts` and `src/commands/graveyard.test.ts`
6. WHEN the removal is performed, THE CLI SHALL remove the local-only `state.json` references used by the local commands (the `statePath` constant and its usage in `plan`, `apply`, `graveyard`, and `init` local command handlers), while retaining any `state.json` writes performed by the remote commands (e.g., `runRemoteInit`)
7. IF a Shared_Module is imported by the Lambda handler or by any remote CLI command source file, THEN THE module SHALL be retained in the main codebase
8. IF a Shared_Module is not imported by the Lambda handler or any remote CLI command source file (determined by static import analysis of the remaining `src/` files), THEN THE module SHALL be removed from the main codebase
9. WHEN the removal is performed, THE `package.json` description SHALL be updated from "Local-first AWS Organizations and IAM Identity Center management CLI" to "AWS Organizations and IAM Identity Center management CLI"
10. THE `local/` folder created in Phase 1 SHALL remain in the repository for this commit (deletion is a separate follow-up)
11. WHEN the removal is performed, THE CLI help text SHALL list the top-level commands (`bootstrap`, `scan`, `init`, `regenerate`, `graveyard`, `plan`, `apply`, `upgrade`) with their flags, and SHALL NOT reference the `remote` subcommand
12. WHEN the removal is performed, THE `graveyard` command SHALL be updated to read state from the remote state cache (`.remote-state-cache.json`) instead of the local `state.json` file, since the local state.json is only written during `init` but the remote state cache is updated after every `scan` and `apply`
13. WHEN the removal is performed, THE project SHALL compile without TypeScript errors using `npm run typecheck` and SHALL build successfully using `npm run build`
14. WHEN the removal is performed, THE remote command test files (`src/commands/remote.test.ts`, `src/commands/remote.permissionset.test.ts`, `src/commands/remote.tagging.test.ts`) SHALL be retained and updated as needed to reflect the promoted command structure

### Requirement 4: Create Architecture Decision Record

**User Story:** As a developer, I want an ADR explaining the decision to remove the local execution model, so that future contributors understand the rationale and know where to find the preserved version.

#### Acceptance Criteria

1. THE ADR SHALL be placed in the `docs/adr/` directory with a numbered filename following the pattern `NNN-title.md`
2. THE ADR SHALL document the rationale for removing the local execution model: the remote model is simpler for end users who only need Lambda invoke permissions rather than full org management permissions, reduces maintenance burden of two execution paths, and the Lambda-based approach provides built-in concurrency control via reserved concurrency
3. THE ADR SHALL include the exact git commit hash of the Phase 1 commit where the last complete local working version can be found in the `local/` folder
4. THE ADR SHALL list the specific files and commands that were removed and the commands that remain
5. THE ADR SHALL note that the remote execution model is now the sole execution path for AWS operations and that the local version can be recovered from the referenced commit

### Requirement 5: Clean Up Remaining Code

**User Story:** As a developer, I want shared modules simplified and unused dependencies removed, so that the codebase reflects only what the remote execution path needs.

#### Acceptance Criteria

1. WHEN cleanup is performed, THE Shared_Modules SHALL have any exported functions, types, or constants that are not imported by the remote execution path or Lambda handler removed
2. WHEN cleanup is performed, THE `package.json` SHALL remove any dependencies that have zero import references in the remaining `src/` tree or `scripts/` directory
3. WHEN cleanup is performed, THE project SHALL compile without TypeScript errors using `npm run typecheck`
4. WHEN cleanup is performed, THE project SHALL build successfully using `npm run build`
5. WHEN cleanup is performed, THE remaining test suite SHALL pass using `npm test`
6. WHEN cleanup is performed, THE Lambda build SHALL succeed using `npm run build:lambda`
7. WHEN cleanup is performed, THE `src/` tree SHALL contain no import statements referencing deleted Local_Command files or modules that were removed in Requirement 3

### Requirement 6: Update Documentation

**User Story:** As a developer, I want the README and project documentation updated to reflect the remote-only architecture, so that users understand the current CLI interface.

#### Acceptance Criteria

1. WHEN the cleanup is complete, THE README SHALL describe the CLI commands (`bootstrap`, `scan`, `init`, `regenerate`, `graveyard`, `plan`, `apply`, `upgrade`) as top-level commands without the `remote` prefix, including updated usage lines and help text examples
2. WHEN the cleanup is complete, THE README SHALL remove all references to the local execution model as a current capability, including: the "Local-first" project description, the local-only workflow lifecycle (reading/writing local `state.json`), the per-command IAM permission statements for local `scan`, `bootstrap`, `init`, and `apply`, and the "Remote commands" section header
3. WHEN the cleanup is complete, THE README SHALL update all usage examples (including the destructive apply examples, FAQ code blocks, and recovery flow) to use the promoted command names without the `remote` prefix
4. WHEN the cleanup is complete, THE README SHALL replace the per-command IAM permissions section with a consolidated section showing that routine CLI usage (`scan`, `plan`, `apply`, `init`) requires only `lambda:InvokeFunction` permission on the deployed Lambda function, and that `bootstrap` and `upgrade` require the infrastructure provisioning permissions
5. WHEN the cleanup is complete, THE README SHALL update the Workflow section to describe the remote-based lifecycle: `bootstrap` deploys infrastructure, `init` triggers remote scan and generates local config files, `plan` computes diff using remote state, and `apply` sends operations to Lambda for execution
6. IF the `docs/` folder contains references to the local execution model as the current architecture (excluding the ADR and the preserved `local/` folder documentation), THEN THE documentation files SHALL be updated or annotated to reflect that the remote execution model is now the sole execution path
