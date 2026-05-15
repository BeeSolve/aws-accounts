# Post-v1 Backlog

v1 is complete: Organizations + IAM Identity Center reconciliation via `plan` / `apply`, with gated destructive operations, `graveyard` for parked accounts, account tags and display-name reconciliation, and `plan --json` destructive summary metadata.

---

## Post-v1 ideas (not committed)

### 1. Account metadata (continued)

Scope:

- Alternate contacts and similar post-create account metadata

Why it was deferred:

- Useful for operations and compliance, but not required for the core org / IdC access workflow delivered in v1
- Broader AWS Account Management / Organizations surface than tags and display name

### 2. Optional: inherited / "global" default tags (research only)

Design notes: [`account-tag-inheritance-research.md`](./account-tag-inheritance-research.md).
Not scheduled until explicitly prioritized.

---

## Suggested order if you pick this up again

1. Alternate contacts (or other chosen account metadata) via the same plan / apply pattern.
2. Revisit inherited OU-level default tags if product need is confirmed.
