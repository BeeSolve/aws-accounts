# Make delivery bucket and Config aggregator creation idempotent

## Problem

The delivery bucket creation and Config aggregator creation are inside the
`if (stackSetOperations != null && stackSetOperations.length > 0)` block in
`src/commands/remote.ts`. After the first `apply` records StackSets as deployed,
subsequent applies skip the entire block — meaning if the aggregator/bucket
failed on first run (race condition with StackSet deployment), they're never
retried.

## Tasks

### Task 1: Move delivery bucket and aggregator creation outside the StackSet conditional

**File:** `src/commands/remote.ts`

Move the delivery bucket section (~lines 900-920) and aggregator section
(~lines 925-949) to after the closing `}` of the StackSet block. Keep them
gated on their own conditions:

- `config.securityBaseline?.configDeliveryBucket` for bucket
- `config.delegatedAdministrators` containing `config.amazonaws.com` for aggregator

All needed variables (`lambdaClient`, `deployment.region`, `currentState`) are
already in the outer scope.

### Task 2: Adjust the "no changes" early return to allow infrastructure-ensuring steps

**File:** `src/commands/remote.ts`

The early return at ~line 790 exits when `plan.operations.length === 0` and
`stackSetOperations` is empty. Add a condition: skip the early return when
`config.securityBaseline != null`, so bucket/aggregator steps still execute.

The confirmation prompt and Lambda apply call are already gated on
`plan.operations.length > 0`, so they won't fire spuriously.

### Task 3: Add test for aggregator creation on subsequent applies

**File:** `src/commands/remote.test.ts`

Add a test that:

- Sets up state with `deployedStackSets` already populated (matching config)
- Config declares `configRecorder` with a delegated admin
- Mocks the Lambda client to track invocations
- Runs `runRemoteApply`
- Asserts that a `createConfigAggregator` payload was sent to the Lambda
