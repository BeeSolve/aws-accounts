# @beesolve/aws-accounts

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
