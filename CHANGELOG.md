# @beesolve/aws-accounts

## 1.6.0

### Minor Changes

- 56adb49: Add security baseline StackSet deployments, Config aggregator, delivery bucket creation, async StackSet tracking, CloudWatch log group management, cross-account role assumption, and declaration generation for the security sub-path export.

## 1.5.0

### Minor Changes

- 3a52050: Add reusable SCP pattern builders via `@beesolve/aws-accounts/policies` sub-path export. First pattern: `scp.blockExpensiveResources()` — generates a deny-by-default SCP that blocks Bedrock, GPU/accelerator EC2 instances, SageMaker, ECS, and expensive purchases, with per-account exemptions.

## 1.4.0

### Minor Changes

- 8183e10: Improve CLI user-facing messages and add progress feedback for long-running operations.

  - `plan` and `apply` now explain why there are no changes and what to do next instead of printing bare "No changes."
  - Cache age is shown when using cached state, with a hint to use `--refresh`
  - Destructive operations are now blocked at the CLI level before invoking Lambda if `--allow-destructive` is not passed
  - Unsupported diffs list now includes a note that manual AWS Console action is required
  - Apply partial failure now suggests running `scan --refresh` before retrying
  - Version mismatch warning is printed before command output instead of after
  - Progress timers print elapsed time every 5 seconds during `apply`, `scan`, `init`, `drift`, and remote state fetch
  - Redundant "State cache updated." after a successful `apply` is suppressed

### Patch Changes

- 751aed6: Fix regenerate crashing when account or OU names have been renamed in aws.config.ts. The generated config file no longer validates itself against the stale types schema at load time; validation happens in the CLI command instead.
- 9eb1c55: Add TTL-gated npm registry version check on CLI start. When a newer version of @beesolve/aws-accounts is available, a one-line upgrade notice is printed at most once per 24 hours.

## 1.3.1

### Patch Changes

- cdc83ec: Fix regenerate crashing when account or OU names have been renamed in aws.config.ts. The generated config file no longer validates itself against the stale types schema at load time; validation happens in the CLI command instead.

## 1.3.0

### Minor Changes

- de4e760: Resolve same-plan OU dependencies: new OUs and accounts/moves targeting them can now be planned and applied in a single cycle instead of requiring two separate plan/apply runs.

### Patch Changes

- 23583ec: Fix scan crash when a permission set has no permissions boundary configured.

## 1.2.1

### Patch Changes

- 4d9539e: Fix help text to show the actual command name instead of `npm run cli --`, and simplify config regeneration to use the model schema directly.
