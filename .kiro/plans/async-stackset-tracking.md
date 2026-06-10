# Async StackSet Operation Tracking — IMPLEMENTED ✓

## What was built

1. **State tracking**: `pendingStackSetOperations` in remote state records `{stackSetName, operationId, startedAt}` for fire-and-forget StackSets
2. **Recording**: After apply, `recordDeployedStackSets` writes both `deployedStackSets` (for idempotency) and `pendingStackSetOperations` (for async tracking)
3. **Checking**: `checkPendingStackSets` Lambda action calls `DescribeStackSetOperation` for each pending op
4. **Blocking**: At start of `plan`/`apply`, pending ops are checked — if any are RUNNING/QUEUED, the command throws with an informative error

## Flow

1. `apply` deploys StackSets:
   - `config-bucket-creator`: waits synchronously (waitForCompletion=true)
   - `config-recorder`, `guardduty-member`: fire-and-forget, operationIds recorded as pending
2. Next `plan`/`apply`:
   - Checks pending ops via Lambda → DescribeStackSetOperation
   - If all SUCCEEDED: proceeds normally
   - If any RUNNING/QUEUED: rejects with "StackSet operation(s) still in progress"

## Future enhancements (not implemented)

- Lambda durable functions for long-running orchestration without timeout
- EventBridge rule on `source: aws.cloudformation` for instant state updates on StackSet completion
- Automatic retry/resume mechanism
