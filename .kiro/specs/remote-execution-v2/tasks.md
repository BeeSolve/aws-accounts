# Implementation Plan: Remote Execution V2

## Overview

Implement the `remote` command group for the `@beesolve/aws-accounts` CLI. The approach extracts shared logic from existing scan/apply commands into reusable modules, adds a Lambda handler (single file), a build script, a state cache module, a Lambda client module, and wires everything together through new CLI commands. Each task builds incrementally on previous work.

## Tasks

- [x] 1. Extract shared logic and create foundational modules
  - [x] 1.1 Extract scan logic into `src/scanLogic.ts`
    - Extract `scanOrganization()` and `scanIdentityCenter()` (and their helper functions) from `src/commands/scan.ts` into `src/scanLogic.ts`
    - Update `src/commands/scan.ts` to import from `src/scanLogic.ts` instead of defining these functions inline
    - Ensure existing `npm run test` passes after extraction
    - _Requirements: 4.2_

  - [x] 1.2 Extract apply logic into `src/applyLogic.ts`
    - Extract the operation execution switch/case logic from `src/commands/apply.ts` into a standalone `executeOperation()` function in `src/applyLogic.ts`
    - The function should accept an operation, AWS clients, working state, and runtime config, and return the updated working state
    - Update `src/commands/apply.ts` to import and use `executeOperation()` from `src/applyLogic.ts`
    - Ensure existing `npm run test` passes after extraction
    - _Requirements: 6.4_

  - [x] 1.3 Extend context file schema with `deployment` key
    - In `src/awsConfig.ts`, extend the context schema to include an optional `deployment` object with fields: `profile`, `region`, `lambdaArn`, `stateBucketName`, `stateCacheTtlSeconds`
    - Use valibot `v.optional()` so existing context files without `deployment` remain valid
    - Export the `Deployment` type
    - _Requirements: 1.5, 1.6, 7.5_

  - [x] 1.4 Create state cache module `src/remoteStateCache.ts`
    - Implement `readStateCache(cachePath)` — reads and parses `.remote-state-cache.json`, returns `StateCacheFile | null`
    - Implement `writeStateCache(cachePath, state)` — writes state with `fetchedAt` ISO timestamp
    - Implement `isCacheFresh(cache, ttlSeconds)` — returns true if elapsed time since `fetchedAt` ≤ TTL
    - Define and export `StateCacheFile` type and valibot schema
    - _Requirements: 5.1, 5.2, 5.5, 7.1, 7.2, 7.3_

  - [x] 1.5 Write property tests for state cache module
    - **Property 2: Cache freshness determination** — for any timestamp and TTL, `isCacheFresh` returns true iff elapsed ≤ TTL
    - **Property 3: State cache round-trip** — for any valid StateFile, write then read produces identical object
    - **Validates: Requirements 5.1, 5.2, 5.5, 7.2, 7.3**

  - [x] 1.6 Create Lambda client module `src/lambdaClient.ts`
    - Implement `invokeLambda(props)` — invokes Lambda with typed payload, parses response with valibot
    - Define `LambdaRequestPayload`, `LambdaResponsePayload`, `LambdaInvokeResult`, `LambdaInvokeError` types
    - Map Lambda errors (FunctionError, concurrency throttle) to typed `LambdaInvokeError` variants
    - Handle JSON parse failures and validation failures gracefully
    - _Requirements: 3.1, 3.2, 8.4, 11.1, 11.2_

  - [x] 1.7 Write unit tests for Lambda client module
    - Test successful invocation parsing
    - Test validation error mapping
    - Test concurrency conflict detection
    - Test invocation error handling (timeout, network)
    - _Requirements: 3.1, 3.2, 8.4_

- [x] 2. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Implement Lambda handler
  - [x] 3.1 Create Lambda handler `src/lambda/handler.ts`
    - Implement the `handler(event)` entry point with valibot validation of incoming event
    - Implement action routing: `scan`, `getStateUrl`, `apply`
    - Implement `scan` action: call `scanOrganization()` and `scanIdentityCenter()` from `src/scanLogic.ts`, write state to S3, return summary + state
    - Implement `getStateUrl` action: generate S3 pre-signed URL for `state.json`, return URL and expiry
    - Implement `apply` action: validate operations against `operationSchema`, execute sequentially using `executeOperation()` from `src/applyLogic.ts`, write updated state to S3 with conditional write, return state
    - Implement error handling: validation errors, concurrency conflicts (S3 PreconditionFailed), operation failures (partial state write), internal errors
    - Validate response against `lambdaResponseSchema` before returning
    - All logic in this single file (schemas, routing, action handlers)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.2, 4.3, 4.4, 6.4, 6.5, 6.6, 6.8, 8.1, 8.3, 11.1, 11.2, 11.3, 11.4_

  - [x] 3.2 Write property tests for Lambda handler
    - **Property 1: Lambda input validation rejects invalid payloads** — arbitrary JSON not conforming to `lambdaRequestSchema` returns validation error
    - **Validates: Requirements 3.1, 3.2, 11.1**

  - [x] 3.3 Write property test for scan summary counts
    - **Property 4: Scan summary counts match state** — for any valid StateFile, summary counts equal array lengths
    - **Validates: Requirements 4.4**

  - [x] 3.4 Write property test for apply partial failure
    - **Property 5: Apply partial failure reports correct completed count** — when operation K fails, `operationsCompleted` equals K
    - **Validates: Requirements 6.8**

  - [x] 3.5 Write property test for concurrency conflict detection
    - **Property 6: Concurrency conflict detection** — S3 PreconditionFailed maps to `concurrencyConflict` error kind
    - **Validates: Requirements 8.1, 8.3**

  - [x] 3.6 Write property test for operation schema validation
    - **Property 7: Operation schema validation reuses existing schema** — valid operations accepted, invalid rejected
    - **Validates: Requirements 11.4**

  - [x] 3.7 Write property test for response self-validation
    - **Property 8: Lambda response schema self-validation** — all handler responses pass `lambdaResponseSchema` validation
    - **Validates: Requirements 11.2, 11.3**

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement build script and CLI command structure
  - [x] 5.1 Create build script `scripts/buildLambda.ts`
    - Use esbuild to bundle `src/lambda/handler.ts` into `dist/lambda/handler.mjs` (ESM, Node.js 24 target, external `@aws-sdk/*`)
    - Zip the output into `dist/lambda.zip` using Node.js zlib or a lightweight zip library
    - Add `"build:lambda": "node --import tsx scripts/buildLambda.ts"` to `package.json` scripts
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 5.2 Add `remote` command group to CLI (`src/cli.ts`)
    - Add `"remote"` to the commands list
    - Parse the second positional arg as the remote subcommand (`bootstrap`, `scan`, `plan`, `apply`, `upgrade`)
    - Parse `--refresh` flag for `remote plan`
    - Display help text listing remote subcommands when `aws-accounts remote` is run without a subcommand
    - Route to `src/commands/remote.ts` handlers
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 5.3 Create remote commands file `src/commands/remote.ts`
    - Implement `remoteBootstrap` — create S3 bucket (deterministic name from account ID + region), IAM role, Lambda function using raw SDK calls; set reserved concurrency to 1; persist `deployment` in context file; reuse existing resources if found; error if `dist/lambda.zip` missing
    - Implement `remoteScan` — invoke Lambda with `{action: "scan"}`, display summary, update state cache
    - Implement `remotePlan` — check cache freshness, fetch state via pre-signed URL if stale (or `--refresh`), load `aws.config.ts`, diff locally, display plan
    - Implement `remoteApply` — compute plan, display and prompt confirmation, invoke Lambda with `{action: "apply", operations}`, handle success/failure, update cache
    - Implement `remoteUpgrade` — read Lambda ARN from context, update function code with `dist/lambda.zip`, log version/timestamp; error if zip missing
    - _Requirements: 1.1–1.9, 4.1, 4.5, 4.6, 5.1–5.7, 6.1–6.9, 9.1–9.4_

  - [x] 5.4 Write unit tests for remote commands
    - Test CLI argument parsing for `remote` subcommands
    - Test help text output for `remote` without subcommand
    - Test `--refresh` flag bypasses cache
    - Test error messages for missing `dist/lambda.zip`
    - Test error messages for missing `deployment` in context
    - Test concurrency conflict error display
    - _Requirements: 10.1, 10.3, 1.7, 8.4_

- [x] 6. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The Lambda handler is a single file per project conventions
- No CloudFormation — all bootstrap uses raw SDK calls
- fast-check is used for property-based testing, node:test for the test runner
- esbuild is used for Lambda bundling (already a project dependency)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["1.4", "1.6"] },
    { "id": 2, "tasks": ["1.5", "1.7"] },
    { "id": 3, "tasks": ["3.1"] },
    { "id": 4, "tasks": ["3.2", "3.3", "3.4", "3.5", "3.6", "3.7"] },
    { "id": 5, "tasks": ["5.1", "5.2"] },
    { "id": 6, "tasks": ["5.3"] },
    { "id": 7, "tasks": ["5.4"] }
  ]
}
```
