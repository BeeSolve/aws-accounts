# Roadmap

Post-v1 features organized by priority tier. See [feature-parity-research.md](./feature-parity-research.md) for the full analysis.

---

## Implemented

### v1.1.0

- **Permission set session duration** — ISO-8601 session duration on permission sets (e.g. `PT4H`). Table-stakes for every org.
- **`profile` command** — interactive picker to generate `~/.aws/config` SSO profile blocks from cached state. Eliminates need for `aws-sso-util`.
- **`validate` command** — local config validation without AWS calls (duplicate names, dangling references, policy size limits).
- **Organization policies: SCPs and RCPs** — create/update/delete Service Control Policies and Resource Control Policies, attach/detach to roots/OUs/accounts, with destructive gates.
- **Tag policies** — enforce tag standardization org-wide via `TAG_POLICY` type (implemented alongside SCPs).
- **AI services opt-out policies** — opt out of AWS AI service data usage for training.
- **Upgrade state sync and `init --update` mode** — version banner on mismatch, post-upgrade guidance, additive init to safely populate new config sections, scan safety guard for undeclared policies. See [ADR 004](./adr/004-upgrade-state-sync-and-version-tracking.md).
- **`graveyard close`** — outputs `aws organizations close-account` commands for eligible graveyarded accounts.

### v1.2.0

- **Account alternate contacts** — manage billing, operations, and security contacts per account. Satisfies CIS AWS Foundations Benchmark 1.1/1.2.
- **ABAC — Attributes for Access Control** — define attribute mappings on the Identity Center instance that enable `${aws:PrincipalTag/key}` conditions in permission set policies.
- **Permission set boundaries** — `PermissionsBoundary` on permission sets (AWS managed or customer-managed policy ARN).
- **Delegated administrator** — register/deregister member accounts as delegated administrators for services (SSO, Organizations, etc.). Useful for security-conscious orgs that avoid running from the management account.
- **`drift` command** — compares last-known state against a fresh live scan to show what changed in AWS since last scan. Helps audit manual console changes before deciding to `scan` (accept as new baseline) or `plan` (reconcile via config).
- **Backup policies** — centralized AWS Backup plans across accounts via `BACKUP_POLICY` org policy type.

---

## Tier 3 — Solid additions (remaining)

_(All Tier 3 items have been implemented.)_

---

## Tier 4 — Long-term

---

### Well-Architected patterns — opinionated org scaffolding

Provide commands that provision recommended OU structures and guardrails based on AWS Well-Architected best practices. Depends on SCPs being implemented first.

**Phase 1: `scaffold sandbox`** — create a Sandbox OU with a pre-configured SCP that limits blast radius.

**Phase 2:** Additional scaffolds for common patterns (workloads, security, governance).

---

### Declarative policies (EC2, VPC)

Newer policy type (2024) for centrally configuring AWS service behavior. Limited adoption so far.

---

### Trusted token issuers / Applications

Enterprise edge cases for M2M auth and SAML/OIDC app integrations. Not related to account access management.
