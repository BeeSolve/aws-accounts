# ADR 007: UX Message Improvements

## Status

Accepted

## Date

2026-05-19

## Context

The CLI's user-facing messages were terse and left users without context on what happened or what to do next. The motivating example: running `apply` when there is nothing to apply printed `No changes.` — which does not explain whether that means "you're already in sync" or "you forgot to set something up."

Other recurring pain points:

- `Using cached state.` gave no indication of how old the cache was or how to bypass it.
- Destructive operations printed a warning but still invoked Lambda; the flag was not enforced at the CLI level.
- Unsupported diffs were listed with no guidance on what the user should do about them.
- After a partial apply failure the user had no hint about the next step.
- The version mismatch warning was printed after command output, making it easy to miss at the end of a long plan.
- Long-running Lambda invocations (scan, apply, drift, state fetch) produced silence for up to 30+ seconds after the initial "Invoking..." line.
- A successful `apply` printed `State cache updated.` after `Applied X operation(s).`, which was redundant noise.

## Decision

Improve all user-facing messages and flows so the CLI guides users rather than just reporting status.

### 1. "No changes." — explain why and what's next

`plan` and `apply` both return early with a descriptive message when there are zero operations:

```
No changes: aws.config.ts already matches the current remote state.
```

`apply` additionally appends an actionable hint:

```
If you expected changes, verify your config with aws-accounts validate or run with --refresh to fetch fresh state.
```

### 2. Cache age in "Using cached state."

The `fetchedAt` timestamp already present on `StateCacheFile` is used to compute elapsed minutes:

```
Using cached state (fetched 4 minute(s) ago). Use --refresh to force a fresh fetch.
```

### 3. Enforce --allow-destructive at the CLI level

After `displayPlan()` and before the confirmation prompt in `runRemoteApply()`, the presence of destructive operations is checked and a hard error is thrown if `--allow-destructive` was not passed. Lambda is never invoked in this case.

### 4. Unsupported diffs — add guidance

After listing unsupported diffs, `displayPlan()` appends:

```
These changes require manual action in the AWS Console and will not be applied automatically.
```

### 5. Apply failure — add next-step hint

After writing partial state on operation failure, the CLI appends:

```
Run aws-accounts scan --refresh to refresh state before retrying.
```

### 6. Version mismatch warning — show before command output

`printVersionBannerIfNeeded()` is called once before the command dispatch block instead of after each command. The warning now appears at the top of output.

### 7. Progress indicator during long-running operations

A `startProgressTimer(onTick, intervalMs?)` utility is added to `src/helpers.ts`. It starts a repeating timer that calls `onTick` with total elapsed seconds, and returns a stop function. Applied to five call sites:

| Command / function | Progress message |
|---|---|
| `runRemoteApply` | `Still applying... (Xs)` |
| `runRemoteScan` | `Still scanning... (Xs)` |
| `runRemoteInit` | `Still scanning... (Xs)` |
| `runRemoteDrift` | `Still scanning... (Xs)` |
| `fetchCurrentState` | `Still fetching... (Xs)` |

`waitForLambdaReady` and `createLambdaFunctionWithRetry` were not changed — they already log per-attempt messages.

### 8. Suppress redundant "State cache updated." after apply

The `State cache updated.` log line is removed from the successful apply path. The `Applied X operation(s).` line already implies the state was updated. The line is kept after explicit `scan` / `--refresh` fetches and after partial apply failures (where it is paired with a more specific message).

## Rationale

- **Why throw on missing --allow-destructive rather than just warn?** The previous behaviour (print a warning, invoke Lambda anyway) left the actual enforcement to the Lambda function, which also did not validate it — meaning destructive operations could silently proceed. A hard CLI-level error makes the contract explicit and prevents accidental data loss.
- **Why a generic `startProgressTimer` helper rather than inline logic?** The same pattern was needed at five independent call sites. A helper with a stop-function return value is composable without coupling callers to a Logger interface.
- **Why not use carriage-return / in-place updates for the progress indicator?** The `Logger` abstraction writes discrete lines; overwriting would require direct `process.stdout` manipulation and break non-TTY consumers (CI logs, piped output).
- **Why move version check before dispatch rather than per-command?** All remote commands benefit equally from the warning. A single call before the dispatch block is simpler and guarantees the warning is never accidentally omitted from a new command.

## Consequences

- Users get actionable guidance when nothing happens, when state is cached, when destructive ops are present, and when an apply partially fails.
- The `--allow-destructive` contract is now enforced end-to-end at the CLI, not delegated to Lambda.
- All slow Lambda calls surface elapsed time every 5 seconds; silence during a long wait is eliminated.
- `startProgressTimer` is available in `src/helpers.ts` for future long-running operations.
