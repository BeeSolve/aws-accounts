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
- Account removal boundary in v1: removing an account from `aws.config.ts`
  plans a destructive move to the reserved `Graveyard` OU

Cloud-backed execution (`Lambda` / `S3` / remote saved plans) remains **v2** and
is intentionally excluded from this backlog.

## Remaining priorities

### 1. Machine-readable destructive plan metadata (polish)

Scope:

- enrich `plan --json` so consumers can distinguish supported destructive
  operations from safe mutations without parsing formatted text

Why first among remaining work:

- agreed sequencing: ship the risky lifecycle feature first, then make automated
  consumers of `plan --json` reliable without scraping human-readable lines
- current human-readable output already exposes destructive intent clearly

### 2. Account metadata reconciliation after creation

Scope:

- account-name drift
- tags
- alternate contacts
- similar post-create metadata

Why second:

- useful, but not a blocker for the core org / IdC access workflow
- likely involves broader AWS Organizations / Account Management API surface

## Recommended implementation sequence

1. Enrich `plan --json` with structured destructive-operation metadata.
2. Finish account metadata parity where it matters for operations.
