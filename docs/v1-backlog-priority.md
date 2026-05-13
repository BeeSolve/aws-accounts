# V1 Backlog Priority

Repository head has now shipped:

- Wave 1 Organizations additive reconciliation
- Wave 2 IAM Identity Center additive reconciliation
- safe OU deletion with destructive gating
- Wave 3 IAM Identity Center group membership management
- Wave 4 IAM Identity Center permission set policy management
- Wave 5 IAM Identity Center entity removal (see
  [`docs/phase-6-wave-5-idc-removal-plan.md`](./phase-6-wave-5-idc-removal-plan.md))
- Wave 6 IAM Identity Center metadata updates after creation (user display name
  and primary Work email when the desired email is non-empty, group description,
  permission set description; description-only permission set changes trigger
  reprovisioning when that permission set has desired account assignments)

Cloud-backed execution (`Lambda` / `S3` / remote saved plans) remains **v2** and
is intentionally excluded from this backlog.

## Remaining priorities

### 1. Account removals

Scope:

- removing accounts from authored config with a safe, explicit boundary

Why first among remaining work:

- it is destructive, organization-wide work
- the expected safety model is stricter than OU deletion because account closure
  / detachment semantics are much harder
- it should wait until the remaining high-value IdC surface is finished

### 2. Account metadata reconciliation after creation

Scope:

- account-name drift
- tags
- alternate contacts
- similar post-create metadata

Why second:

- useful, but not a blocker for the core org / IdC access workflow
- likely involves broader AWS Organizations / Account Management API surface
- fits better after the access-management backlog is materially complete

### 3. Machine-readable destructive plan metadata

Scope:

- enrich `plan --json` so consumers can distinguish supported destructive
  operations from safe mutations without parsing formatted text

Why third:

- this is polish rather than a missing core reconciliation capability
- current human-readable output already exposes destructive intent clearly
- it is still worth doing before v1 finalization if automation consumers need it

## Recommended implementation sequence

1. Decide whether account removal belongs in strict v1 or a guarded v1.1 slice.
2. Finish account metadata parity where it matters for operations.
3. Finish lower-priority polish (`plan --json` destructive metadata).

## Notes

- If a strong operational need appears for machine-readable plan metadata, item
  3 can move earlier without affecting the core reconciliation design.
