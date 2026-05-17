# ADR 004: Upgrade State Sync and Version Tracking

## Status

Accepted

## Date

2026-05-17

## Context

When a new feature (e.g. SCP/RCP support added in v1.1.0) is released, the upgrade path has a dangerous gap: a user can update the CLI locally and run `upgrade` to deploy the new Lambda, but their `aws.config.ts` does not yet include the new feature's config section. Depending on what they do next, this can lead to destructive operations.

### State of the system after `upgrade`

- **Local config** (`aws.config.ts`): no `policies` section — the user hasn't added SCPs yet
- **Lambda code**: now SCP/RCP-aware
- **S3 remote state**: still the old snapshot — no `policies`/`policyAttachments` fields (both are `v.optional()` and default to `[]` during parsing)
- **Local state cache** (`.remote-state-cache.json`): also old — no policy data

### Path analysis

| Path | What happens | Safe? |
|------|-------------|-------|
| `upgrade → plan/apply` | Old state has `policies = []`; local config has `policies = []`; diff is zero — no policy operations | **Safe** |
| `upgrade → scan → plan/apply` | New Lambda scans live AWS, discovers existing SCPs (including AWS-managed `FullAWSAccess` attached to root and every OU), writes them to S3 state. Local config still has no policies. Diff generates **DELETE operations for all discovered SCPs**. | **Dangerous** |
| `upgrade → init → plan/apply` | `init` scans and regenerates `aws.config.ts` including newly-discovered policies. Local config matches AWS state. Diff is zero. | **Safe** |

The `upgrade → scan → plan/apply` path is the dangerous one. `scan` is the natural thing to do after an upgrade ("refresh state"), and there is currently nothing to warn the user that doing so will cause `plan/apply` to try to delete every SCP in the organization.

### Additional problem: no version awareness

The CLI has no mechanism to tell the user that a `upgrade` is needed after they install a new package version. Users may install a new CLI version and continue using plan/apply against a stale Lambda for days without knowing.

`aws.context.json` already has a `version` field (schema/config version) and a `deployment` section, but neither stores the CLI version that was last deployed to Lambda.

## Decision

Implement four complementary safeguards:

### 1. CLI version tracking in `aws.context.json`

Add `cliVersion?: string` to the `deployment` section of `aws.context.json`. After each successful `upgrade`, write the current `package.json` version to `deployment.cliVersion`. On every CLI run, compare the running version to the stored `cliVersion`; if they differ, print a banner after command output:

> `New version installed (local: X.Y.Z, remote: A.B.C). Run upgrade then init --update to sync.`

### 2. Post-upgrade guidance message

After Lambda update succeeds in `runRemoteUpgrade`, print:

> `Run init --update to sync your config with new remote features before using plan/apply.`

This is the primary user-facing prompt. It costs nothing and directs the user to the safe path.

### 3. Additive `init --update` mode

Add `--update` flag to the `init` command. When passed:

- Scan remote state (same as regular `init`)
- For each top-level config section present in the scanned state but **absent** in the existing `aws.config.ts`, append it — do not overwrite existing sections
- Update `aws.context.json` (`generatedAt`, `cliVersion`) but preserve all other context values

This gives users a safe, non-destructive way to bring their config up to date after upgrade. After running it, `plan` shows zero diffs and the user has a correct baseline to modify.

### 4. Scan safety guard

In `runRemotePlan` and `runRemoteApply`, after fetching current remote state: if the state contains policies but the local config has none, print a warning before proceeding:

> `Remote state contains SCPs/RCPs not present in your config. Proceeding could delete them. Run init --update to sync first.`

This acts as defense in depth — catching the user even if they missed the post-upgrade message or the version banner.

## Rationale

- **Why not auto-run scan+init after upgrade?** That would silently overwrite user-customized config and feels surprising. Explicit `init --update` is safer and more predictable.
- **Why a banner rather than blocking?** The version mismatch is a warning, not an error. Users may be intentionally running plan-only operations against a slightly stale Lambda; blocking would be over-aggressive.
- **Why `--update` flag rather than a new command?** `init` already owns the "scan + generate config" workflow. An `--update` variant is the natural extension — additive init.
- **Why is the scan guard non-blocking?** The user may genuinely want to delete all SCPs (unlikely but valid). A warning that can be acknowledged is more appropriate than a hard stop.

## Consequences

- Users who upgrade the CLI and Lambda will see a clear, actionable banner pointing them to `init --update`.
- Running `scan` after upgrade no longer silently sets up a state that would delete existing SCPs.
- `aws.context.json` gains a `cliVersion` field in its `deployment` section — backwards-compatible (optional field).
- `init --update` provides a safe, incremental migration path for any future feature additions.

## Files to Modify

| File | Change |
|------|--------|
| `src/awsConfig.ts` | Add `cliVersion?: string` to `deploymentSchema` |
| `src/commands/remote.ts` | Write version after upgrade; add `--update` flag to init; add safety guard to plan/apply |
| `src/cli.ts` | Version banner on startup |
