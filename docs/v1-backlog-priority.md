# V1 Backlog Priority

Repository head has now shipped:

- Wave 1 Organizations additive reconciliation
- Wave 2 IAM Identity Center additive reconciliation
- safe OU deletion with destructive gating
- Wave 3 IAM Identity Center group membership management

Cloud-backed execution (`Lambda` / `S3` / remote saved plans) remains **v2** and
is intentionally excluded from this backlog.

## Priority order

### 1. Permission set policy / attachment management

Reference plan:

- [`docs/phase-6-wave-4-permission-set-policy-plan.md`](./phase-6-wave-4-permission-set-policy-plan.md)

Why first:

- it is the biggest remaining IAM Identity Center functional gap
- permission sets can already be created and assigned, but not fully defined
- it composes directly with the newly shipped group-membership support
- it is safer and narrower than destructive lifecycle work

### 2. IAM Identity Center entity removal

Scope:

- remove users
- remove groups
- remove permission sets

Why second:

- the diff engine already knows how to suppress derivative assignment /
  membership noise around unsupported removals
- this is high-value cleanup functionality, but it is destructive and should
  follow the safer permission-set policy wave
- permission set removal becomes clearer once policy management is complete

### 3. IAM Identity Center metadata updates after creation

Scope:

- user metadata edits
- group metadata edits
- permission set metadata edits

Why third:

- this is important for parity, but lower-value than lifecycle and access-model
  completeness
- it is less risky than deletion, yet less urgent than policy support
- it can build on the richer permission-set update machinery from priority 1

### 4. Account removals

Scope:

- removing accounts from authored config with a safe, explicit boundary

Why fourth:

- it is destructive, organization-wide work
- the expected safety model is stricter than OU deletion because account closure
  / detachment semantics are much harder
- it should wait until the remaining high-value IdC surface is finished

### 5. Account metadata reconciliation after creation

Scope:

- account-name drift
- tags
- alternate contacts
- similar post-create metadata

Why fifth:

- useful, but not a blocker for the core org / IdC access workflow
- likely involves broader AWS Organizations / Account Management API surface
- fits better after the access-management backlog is materially complete

### 6. Machine-readable destructive plan metadata

Scope:

- enrich `plan --json` so consumers can distinguish supported destructive
  operations from safe mutations without parsing formatted text

Why sixth:

- this is polish rather than a missing core reconciliation capability
- current human-readable output already exposes destructive intent clearly
- it is still worth doing before v1 finalization if automation consumers need it

## Recommended implementation sequence

1. Ship Wave 4 permission set policy / attachment management.
2. Revisit destructive IdC lifecycle with explicit safety rules.
3. Add non-destructive metadata-update support for IdC entities.
4. Decide whether account removal belongs in strict v1 or a guarded v1.1 slice.
5. Finish lower-priority polish (`plan --json` destructive metadata, account
   metadata parity).

## Notes

- If scope needs to tighten further, priority 1 should stay intact and priority
  2 can be split into separate user/group removal and permission-set removal
  waves.
- If a strong operational need appears for machine-readable plan metadata, item
  6 can move earlier without affecting the core reconciliation design.
