# V1 Backlog Priority

Repository head has now shipped:

- Wave 1 Organizations additive reconciliation
- Wave 2 IAM Identity Center additive reconciliation
- safe OU deletion with destructive gating
- Wave 3 IAM Identity Center group membership management
- Wave 4 IAM Identity Center permission set policy management

Cloud-backed execution (`Lambda` / `S3` / remote saved plans) remains **v2** and
is intentionally excluded from this backlog.

## Priority order

### 1. IAM Identity Center entity removal

Reference plan:

- [`docs/phase-6-wave-5-idc-removal-plan.md`](./phase-6-wave-5-idc-removal-plan.md)

Why first:

- the diff engine already knows how to suppress derivative assignment /
  membership noise around unsupported removals, which can now be turned into
  explicit prerequisite operations
- permission set policy management is already shipped, so permission set
  removal boundaries are now clearer
- this is the highest-value remaining lifecycle gap in the IdC surface

### 2. IAM Identity Center metadata updates after creation

Scope:

- user metadata edits
- group metadata edits
- permission set metadata edits

Why second:

- this is important for parity, but lower-value than lifecycle and access-model
  completeness
- it is less risky than deletion, yet less urgent than policy support
- it can build on the richer permission-set update machinery from shipped Wave 4

### 3. Account removals

Scope:

- removing accounts from authored config with a safe, explicit boundary

Why third:

- it is destructive, organization-wide work
- the expected safety model is stricter than OU deletion because account closure
  / detachment semantics are much harder
- it should wait until the remaining high-value IdC surface is finished

### 4. Account metadata reconciliation after creation

Scope:

- account-name drift
- tags
- alternate contacts
- similar post-create metadata

Why fourth:

- useful, but not a blocker for the core org / IdC access workflow
- likely involves broader AWS Organizations / Account Management API surface
- fits better after the access-management backlog is materially complete

### 5. Machine-readable destructive plan metadata

Scope:

- enrich `plan --json` so consumers can distinguish supported destructive
  operations from safe mutations without parsing formatted text

Why fifth:

- this is polish rather than a missing core reconciliation capability
- current human-readable output already exposes destructive intent clearly
- it is still worth doing before v1 finalization if automation consumers need it

## Recommended implementation sequence

1. Revisit destructive IdC lifecycle with explicit safety rules.
2. Add non-destructive metadata-update support for IdC entities.
3. Decide whether account removal belongs in strict v1 or a guarded v1.1 slice.
4. Finish lower-priority polish (`plan --json` destructive metadata, account
   metadata parity).

## Notes

- If scope needs to tighten further, priority 1 should stay intact and can be
  split into separate user/group removal and permission-set removal
  waves.
- If a strong operational need appears for machine-readable plan metadata, item
  5 can move earlier without affecting the core reconciliation design.
