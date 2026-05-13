# V1 complete — post‑v1 backlog

**v1 is complete** for the agreed local-first product: Organizations + IAM Identity Center reconciliation via `plan` / `apply`, with gated destructive operations, `graveyard` for parked accounts, account tags and display-name reconciliation, and `plan --json` destructive summary metadata.

What shipped in v1 (high level):

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
is intentionally excluded from v1.

---

## Post‑v1 ideas (not committed)

### 1. Account metadata (continued)

Scope:

- alternate contacts and similar post-create account metadata

Why it was deferred:

- useful for operations and compliance, but not required for the core org /
  IdC access workflow delivered in v1
- broader AWS Account Management / Organizations surface than tags and display
  name

### 2. Optional: inherited / “global” default tags (research only)

Design notes: [`account-tag-inheritance-research.md`](./account-tag-inheritance-research.md).
Not scheduled until explicitly prioritized.

---

## Suggested order if you pick this up again

1. Alternate contacts (or other chosen account metadata) via the same plan /
   apply pattern.
2. Revisit inherited OU-level default tags if product need is confirmed.
3. v2: Lambda/S3-backed `apply`, persisted plans, or other remote execution
   models as separately scoped work.
