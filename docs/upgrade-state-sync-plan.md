# Upgrade State Sync & Version Tracking

## Context

When a new feature (e.g. SCP/RCP support) is added and a user upgrades the CLI, there is a window where local config and remote state can diverge in a dangerous way:

- **Safe path**: `upgrade → plan/apply` — old S3 state has no `policies` field (optional, defaults to `[]`); local config also has none; diff is zero.
- **Dangerous path**: `upgrade → scan → plan/apply` — new Lambda discovers existing SCPs (including AWS-default `FullAWSAccess`), writes them to S3 state; local config still has no `policies`; diff generates **DELETE operations for all existing SCPs**.
- **Safe path**: `upgrade → init → plan/apply` — `init` regenerates `aws.config.ts` including newly-discovered policies; diff is zero; clean baseline.

The solution is a combination of version tracking (notify user to upgrade + run sync) and an additive config sync mode that populates new config sections from live state without overwriting existing ones.

## Checklist

### 1. Version tracking in `aws.context.json`

- [x] Add `cliVersion?: string` to `deploymentSchema` in `src/awsConfig.ts`
- [x] After successful `upgrade`, write current `package.json` version to `deployment.cliVersion` in `aws.context.json`
- [x] On every CLI run (in `src/cli.ts`), read context and compare stored `cliVersion` to current version; if they differ, print a banner after command output:
  > `New version installed (local: X.Y.Z, remote: A.B.C). Run upgrade then init --update to sync.`

### 2. Post-upgrade guidance message

- [x] In `runRemoteUpgrade` (`src/commands/remote.ts`), after Lambda update succeeds, print:
  > `Run init --update to sync your config with new remote features before using plan/apply.`

### 3. Additive `init --update` mode

- [x] Add `--update` flag to the `init` command
- [x] When `--update` is passed: scan remote state, then for each top-level config section (`policies`, etc.) that is absent in the existing `aws.config.ts`, append it — do **not** overwrite existing sections
- [x] After merge, update `aws.context.json` (`generatedAt`, `cliVersion`) but preserve all existing context values

### 4. Scan safety guard

- [x] In `runRemotePlan` and `runRemoteApply` (`src/commands/remote.ts`): after fetching current state, check if remote has policies but local config has none
- [x] If so, print a warning:
  > `Remote state contains SCPs/RCPs not present in your config. Proceeding could delete them. Run init --update to sync first.`
- [ ] Optionally gate behind `--force` flag to require explicit acknowledgement (deferred — warning-only is sufficient for now)

## Files Affected

| File | Changes |
|------|---------|
| `src/awsConfig.ts` | Add `cliVersion` to `deploymentSchema` |
| `src/commands/remote.ts` | Write version after upgrade; add `--update` flag to init; add safety guard to plan/apply |
| `src/cli.ts` | Version banner on startup |
