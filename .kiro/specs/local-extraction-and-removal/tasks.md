# Implementation Plan: Local Extraction and Removal

## Overview

This plan restructures the @beesolve/aws-accounts codebase across three sequential phases: (1) extract local execution code into a standalone `local/` folder, (2) remove local-specific code from `src/` and promote remote commands to top-level, (3) clean up dead code, unused dependencies, and update documentation. Phase 1 must be fully committed before Phase 2 begins.

## Tasks

- [x] 1. Phase 1 — Extract local execution code into `local/` folder
  - [x] 1.1 Create `local/package.json` and `local/tsconfig.json`
    - Create `local/package.json` with name `@beesolve/aws-accounts-local`, type `module`, and all dependencies needed for local execution: @aws-sdk/client-organizations, @aws-sdk/client-sso-admin, @aws-sdk/client-identitystore, @aws-sdk/client-account, @aws-sdk/client-sts, @aws-sdk/credential-providers, @beesolve/iam-policy-ts, esbuild, valibot; devDependencies: typescript, @types/node
    - Include build script: `esbuild $(find src -name '*.ts' ! -name '*.test.ts') --platform=node --target=node24 --format=esm --outdir=dist --outbase=src && chmod +x dist/cli.js`
    - Include typecheck script: `tsc --noEmit`
    - Include test script matching the parent project pattern
    - Create `local/tsconfig.json` as standalone config: target ES2022, module NodeNext, moduleResolution NodeNext, noEmit true, allowImportingTsExtensions true, strict true, include `["src/**/*.ts"]`
    - _Requirements: 1.3, 1.4, 1.5_

  - [x] 1.2 Copy shared modules into `local/src/`
    - Copy all shared modules into `local/src/`: state.ts, diff.ts, operations.ts, applyLogic.ts, scanLogic.ts, helpers.ts, awsConfig.ts, awsClientConfig.ts, error.ts, tags.ts, accountCreation.ts, reservedOuDeletion.ts, logger.ts
    - Copy associated test files: state.test.ts, diff.test.ts, operations.test.ts, helpers.test.ts, awsConfig.test.ts, awsConfig.regeneration.test.ts, error.test.ts, tags.test.ts, tags.property.test.ts
    - Ensure all import paths use relative references within `local/src/` (no imports outside `local/`)
    - _Requirements: 1.1, 1.2_

  - [x] 1.3 Copy local command files into `local/src/commands/`
    - Copy all 7 local command implementations: scan.ts, bootstrap.ts, init.ts, regenerate.ts, plan.ts, apply.ts, graveyard.ts
    - Copy all associated test files: scan.test.ts, bootstrap.test.ts, init.test.ts, regenerate.test.ts, plan.test.ts, apply.test.ts, graveyard.test.ts
    - Verify import paths reference `../` shared modules within `local/src/`
    - _Requirements: 1.6, 1.8_

  - [x] 1.4 Create local-only CLI entry point at `local/src/cli.ts`
    - Create a modified `cli.ts` that registers only: scan, bootstrap, init, regenerate, plan, apply, graveyard
    - Remove all remote-related imports (LambdaClient, S3Client, IAMClient, STSClient, remote.ts functions)
    - Remove the `remote` subcommand namespace and its help text
    - Remove imports of `lambdaClient.ts` and `remoteStateCache.ts`
    - Ensure the shebang line `#!/usr/bin/env node` is present for CLI execution
    - _Requirements: 1.7, 1.9_

  - [x] 1.5 Validate extraction folder compiles and builds
    - Run `tsc --noEmit` in `local/` to verify all imports resolve and types are correct
    - Run `npm run build` in `local/` to verify esbuild produces `dist/cli.js`
    - Verify `node dist/cli.js --help` exits with code 0
    - Verify `node dist/cli.js unknown` exits with non-zero code
    - Verify no import statements reference paths outside `local/` (grep for `../../` or absolute paths)
    - _Requirements: 1.1, 1.5, 1.10, 1.11_

- [x] 2. Checkpoint — Phase 1 complete
  - Ensure all tests pass, ask the user if questions arise.
  - Remind the user to commit the `local/` folder as a discrete commit with message containing "preserve local execution model" before proceeding to Phase 2.
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 3. Phase 2 — Remove local execution code and promote remote commands
  - [x] 3.1 Delete local-only command source files and test files
    - Delete `src/commands/scan.ts`, `src/commands/bootstrap.ts`, `src/commands/init.ts`, `src/commands/plan.ts`, `src/commands/apply.ts`
    - Delete `src/commands/scan.test.ts`, `src/commands/bootstrap.test.ts`, `src/commands/init.test.ts`, `src/commands/plan.test.ts`, `src/commands/apply.test.ts`
    - Retain `src/commands/regenerate.ts`, `src/commands/regenerate.test.ts`, `src/commands/graveyard.ts`, `src/commands/graveyard.test.ts`
    - _Requirements: 3.4, 3.5_

  - [x] 3.2 Rewrite `src/cli.ts` to promote remote commands to top-level
    - Remove imports for deleted local commands (runScanCommand, runBootstrapCommand, runInitCommand, runPlanCommand, runApplyCommand)
    - Remove AWS SDK client instantiations only needed by local commands (OrganizationsClient, AccountClient, SSOAdminClient, IdentitystoreClient used directly in local handlers)
    - Change the `commands` array to: `["bootstrap", "scan", "init", "regenerate", "graveyard", "plan", "apply", "upgrade"]`
    - Remove the `remote` subcommand namespace, `remoteSubcommands` array, `isRemoteSubcommand` function, and `printRemoteHelp` function
    - Route `bootstrap`, `scan`, `init`, `plan`, `apply`, `upgrade` directly to the remote command handlers (runRemoteBootstrap, runRemoteScan, runRemoteInit, runRemotePlan, runRemoteApply, runRemoteUpgrade)
    - Retain `regenerate` and `graveyard` routing as-is (they are local utility commands)
    - Remove the `statePath` constant (no longer used by top-level CLI routing)
    - Update `printHelp` to list: bootstrap, scan, init, regenerate, graveyard, plan, apply, upgrade — without the `remote` prefix
    - Remove unused timeout constants (createAccountTimeoutInMs, etc.) that were only used by local apply
    - _Requirements: 3.1, 3.2, 3.3, 3.11_

  - [x] 3.3 Update `src/commands/graveyard.ts` to read from `.remote-state-cache.json`
    - Replace the import of `readStateFile` from `../state.js` with import of `readStateCache` from `../remoteStateCache.js`
    - Change the `statePath` parameter to `cachePath` in `GraveyardCommandInput`
    - Update the implementation to call `readStateCache(props.cachePath)` and extract `.state` from the result
    - Handle the case where cache is null (no cache file exists) with an appropriate error message
    - Update the CLI routing in `src/cli.ts` to pass `.remote-state-cache.json` as the cache path instead of `state.json`
    - _Requirements: 3.12_

  - [x] 3.4 Update `src/commands/graveyard.test.ts` for new cache-based interface
    - Update test mocks to use `readStateCache` instead of `readStateFile`
    - Update test inputs to pass `cachePath` instead of `statePath`
    - Add test case for null cache (no cache file) error handling
    - _Requirements: 3.12, 3.14_

  - [x] 3.5 Update remote command test files for promoted structure
    - Update `src/commands/remote.test.ts`, `src/commands/remote.permissionset.test.ts`, `src/commands/remote.tagging.test.ts` as needed to reflect that commands are now top-level (update any test descriptions or imports that reference the `remote` namespace)
    - _Requirements: 3.14_

  - [x] 3.6 Update `package.json` description
    - Change description from "Local-first AWS Organizations and IAM Identity Center management CLI" to "AWS Organizations and IAM Identity Center management CLI"
    - _Requirements: 3.9_

  - [x] 3.7 Validate Phase 2 — typecheck, build, and tests pass
    - Run `npm run typecheck` to verify no dangling imports to deleted files
    - Run `npm run build` to verify build succeeds
    - Run `npm test` to verify remaining tests pass (remote.test.ts, remote.permissionset.test.ts, remote.tagging.test.ts, regenerate.test.ts, graveyard.test.ts, and shared module tests)
    - Verify no import statements in `src/` reference deleted local command files
    - _Requirements: 3.13, 5.7_

- [x] 4. Checkpoint — Phase 2 complete
  - Ensure all tests pass, ask the user if questions arise.
  - Remind the user to commit Phase 2 changes before proceeding to Phase 3.
  - _Requirements: 2.3_

- [x] 5. Phase 3 — Cleanup dead code, dependencies, and documentation
  - [x] 5.1 Remove unused exports from shared modules
    - Perform static import analysis of remaining `src/` files (including lambda/handler.ts)
    - Remove exported functions, types, or constants from shared modules that have zero import references from the remote execution path or Lambda handler
    - Verify `npm run typecheck` still passes after each removal
    - _Requirements: 5.1_

  - [x] 5.2 Remove unused dependencies from `package.json`
    - Analyze imports across remaining `src/` and `scripts/` to identify dependencies with zero references
    - Remove any unused dependencies (likely candidates: check if any @aws-sdk clients are no longer directly imported in `src/`)
    - Run `npm install` to update lockfile
    - _Requirements: 5.2_

  - [x] 5.3 Create Architecture Decision Record
    - Create `docs/adr/001-remove-local-execution-model.md`
    - Document rationale: remote model is simpler (users only need lambda:InvokeFunction), reduces maintenance of two execution paths, Lambda provides built-in concurrency control
    - Include the Phase 1 commit hash (ask user for the hash or reference it from git log)
    - List specific files and commands removed vs retained
    - Note that the remote execution model is now the sole path for AWS operations
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 5.4 Update README.md for remote-only architecture
    - Update project description to remove "Local-first" references
    - Update command documentation to list bootstrap, scan, init, regenerate, graveyard, plan, apply, upgrade as top-level commands without `remote` prefix
    - Update all usage examples (destructive apply examples, FAQ code blocks, recovery flow) to use promoted command names
    - Replace per-command IAM permissions with consolidated section: routine usage requires `lambda:InvokeFunction`, bootstrap/upgrade require infrastructure permissions
    - Update Workflow section to describe remote-based lifecycle: bootstrap deploys infrastructure, init triggers remote scan + generates config, plan computes diff using remote state, apply sends operations to Lambda
    - Remove the "Remote commands" section header and local-only workflow descriptions
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 5.5 Update docs/ files referencing local execution model
    - Review files in `docs/` for references to local execution as current architecture
    - Annotate or update relevant docs to reflect remote-only execution (excluding the ADR itself)
    - _Requirements: 6.6_

  - [x] 5.6 Final validation — full test suite, Lambda build, typecheck
    - Run `npm run typecheck` — must pass
    - Run `npm run build` — must succeed
    - Run `npm test` — all remaining tests must pass
    - Run `npm run build:lambda` — Lambda build must succeed
    - Verify no import statements reference deleted files or removed modules
    - _Requirements: 5.3, 5.4, 5.5, 5.6, 5.7_

- [x] 6. Final checkpoint — All phases complete
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Phase 1 MUST be committed as a discrete git commit before Phase 2 begins (Requirement 2)
- The `regenerate` and `graveyard` commands are local utility commands that do NOT call AWS SDK — they only read/write local files and are retained in the main codebase
- The `graveyard` command switches from reading `state.json` to reading `.remote-state-cache.json` because the cache is updated after every `scan` and `apply`
- Property-based testing is NOT applicable for this feature — it is a code restructuring task with structural correctness criteria, not behavioral properties across an input space
- The `local/` folder remains in the repository after Phase 2 (it was committed in Phase 1 as a recovery point)
- All shared modules are retained because they are imported by either the Lambda handler or remote commands

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["1.4"] },
    { "id": 3, "tasks": ["1.5"] },
    { "id": 4, "tasks": ["3.1"] },
    { "id": 5, "tasks": ["3.2", "3.3", "3.6"] },
    { "id": 6, "tasks": ["3.4", "3.5"] },
    { "id": 7, "tasks": ["3.7"] },
    { "id": 8, "tasks": ["5.1"] },
    { "id": 9, "tasks": ["5.2", "5.3"] },
    { "id": 10, "tasks": ["5.4", "5.5"] },
    { "id": 11, "tasks": ["5.6"] }
  ]
}
```
