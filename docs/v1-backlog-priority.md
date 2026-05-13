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
- `plan --json` summary metadata for destructive vs safe changes (operation and
  unsupported counts, `hasDestructiveChanges`)
- Account metadata: resource tags and member account display name reconciliation
  (`organizations:TagResource` / `UntagResource`, `account:PutAccountName`)

Cloud-backed execution (`Lambda` / `S3` / remote saved plans) remains **v2** and
is intentionally excluded from this backlog.

## Remaining priorities

### 1. Account metadata (continued)

Scope:

- alternate contacts and similar post-create account metadata

Why next:

- useful for operations and compliance, but not a blocker for the core org /
  IdC access workflow
- broader AWS Account Management / Organizations surface than tags and display
  name

### 2. Optional: inherited / “global” default tags (research only for now)

Design notes: [`account-tag-inheritance-research.md`](./account-tag-inheritance-research.md).
Not scheduled until explicitly prioritized.

## Recommended implementation sequence

1. Alternate contacts (or other chosen account metadata) via the same plan /
   apply pattern.
2. Revisit inherited OU-level default tags if product need is confirmed.
