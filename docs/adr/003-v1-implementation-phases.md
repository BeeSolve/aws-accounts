# ADR 003: V1 Implementation Phases

## Status

Accepted (v1 complete)

## Date

2025-01-15

## Context

The v1 CLI was built incrementally across six phases, each adding a layer of functionality. This ADR records the key decisions made during implementation that still inform the codebase's design.

## Phases Delivered

### Phase 1: Scan

- `scan` reads AWS Organizations and Identity Center state, persists to `state.json`
- Flat organization model with parent references (OUs as flat list with `parentId`)
- Strict validation — unknown fields rejected, entire scan fails if any section fails
- Deterministic sorting by stable identifiers for diff-friendly output
- Identity Center instance selection: exactly one auto-selected, multiple requires `--instance-arn`

### Phase 2: Bootstrap

- `bootstrap` ensures `Graveyard` OU exists under organization root
- Idempotent — safe to re-run on already-bootstrapped organizations
- Persists context to `aws.context.json` (root ID, graveyard OU ID, Identity Center metadata)
- No merging of ambiguous context — disagreement between file and live AWS fails fast
- Identity Center metadata always required (instance ARN + identity store ID)

### Phase 3: Init and Regenerate

- `init` orchestrates bootstrap → scan → config generation
- `regenerate` refreshes `aws.config.types.ts` picklists from current `aws.config.ts`
- Config loader: esbuild compiles `aws.config.ts` to temp `.mjs`, dynamic import, validate, cleanup
- Deterministic codegen: OUs depth-first then alphabetical, everything else alphabetical
- Non-destructive file writes with confirmation callbacks
- Cross-file consistency validation (state vs context identifiers must agree)

### Phase 4: Account Creation

- `createAccount` operation emitted by plan for newly authored config accounts
- Direct creation in target OU (no staging via Pending OU)
- Polling-based progress with configurable timeouts

### Phase 5: Plan/Apply Reconciliation

- `plan` is read-only (no AWS calls) — loads config, reads state, computes diff
- `apply` recomputes plan inline (no saved artifact), confirms, executes via Lambda
- Sequential operation execution with in-memory state tracking
- Partial failure: persists progress, exits non-zero, guides user to scan + re-apply
- Two-tier unsupported diff handling: destructive always blocks, non-destructive skippable with flag
- No automatic rollback (AWS has no transaction primitives)

### Phase 6: Identity Center and Extended Operations

- Wave 1: Organizations additive (move accounts, create/rename/delete OUs)
- Wave 2: Identity Center additive (users, groups, permission sets, assignments)
- Wave 3: Group membership management
- Wave 4: Permission set policies (inline, AWS managed, customer managed) with reprovisioning
- Wave 5: Identity Center entity removal (gated destructive)
- Wave 6: Metadata updates (user display name/email, group description, permission set description)
- Account tags and display name reconciliation
- Account removal via move to Graveyard OU (manual closure required)

## Key Design Decisions

### No Saved Plan Artifact

Apply recomputes the plan from current config and state. A saved artifact (like Terraform's plan file) was deferred because:
- Main value is review-across-sessions and CI separation — less critical for single-operator use
- Requires versioned format and state-fingerprint validation to refuse stale plans

### No Automatic Re-scan After Apply

Post-apply state comes from the planned-next-state, not a fresh scan. This avoids an extra AWS round-trip and keeps apply deterministic. Users run `scan` explicitly for recovery.

### Graveyard OU for Account Removal

AWS accounts cannot be deleted programmatically (only closed manually). Removing an account from config moves it to the reserved `Graveyard` OU. The `graveyard` command lists parked accounts with close commands.

### Safe OU Deletion Boundary

OU deletion requires: all descendants also removed, all become empty through same-batch moves, deepest-first execution order, live preflight checks before each delete. Graveyard deletion is always blocked.

## Consequences

- The phased approach allowed shipping useful functionality early while deferring complexity
- Config-driven reconciliation with safety gates prevents accidental destructive changes
- The plan/apply model is familiar to Terraform users but simpler (no state locking, no saved plans)
- Identity Center support is comprehensive for the common access management workflow
