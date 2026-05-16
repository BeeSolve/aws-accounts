# Feature Parity Research: AWS Organizations & IAM Identity Center

Research conducted May 2026. Compares current tool capabilities against available AWS APIs to identify gaps and prioritize additions.

---

## Current coverage

### AWS Organizations (supported)

- Create, rename, delete OUs
- Move accounts between OUs
- Create and rename member accounts
- Reconcile account resource tags
- Park removed accounts in Graveyard OU

### IAM Identity Center (supported)

- Create/delete users and groups
- Update user display name and email
- Update group descriptions
- Manage group memberships
- Create/update/delete permission sets (inline policies, AWS managed policies, customer-managed policy references)
- Grant/revoke account assignments
- Reprovision changed permission sets

---

## Gaps: Permission set properties

| Property | API | Status | Impact |
|----------|-----|--------|--------|
| Session duration | `SessionDuration` on `CreatePermissionSet` / `UpdatePermissionSet` (ISO-8601, max 12h) | **Missing** | **High** — default 1h is too short for most workflows. Every user configures this. |
| Relay state | `RelayState` on permission set | Missing | Low — niche, sends users to a specific console page on login. |
| Permissions boundary | `PutPermissionsBoundaryToPermissionSet` | Missing (on roadmap) | Medium |
| Tags on permission sets | `TagResource` / `UntagResource` on permission set ARN | Missing | Low — useful for governance/cost allocation. |

---

## Gaps: Organization policy types

AWS Organizations supports 6 policy types. We support none.

| Policy type | API type constant | Complexity | Impact |
|-------------|-------------------|------------|--------|
| **Service Control Policies (SCPs)** | `SERVICE_CONTROL_POLICY` | Medium-high | **Very high** — #1 governance primitive. Controls maximum permissions for all accounts. |
| **Resource Control Policies (RCPs)** | `RESOURCE_CONTROL_POLICY` | Medium | High — newer (2024), controls resource-level access. Same API pattern as SCPs. |
| **Tag policies** | `TAG_POLICY` | Low-medium | **High** — enforces tag standardization org-wide. Universal governance need. |
| **Backup policies** | `BACKUP_POLICY` | Medium | Medium — centralized backup plans across accounts. |
| **AI services opt-out policies** | `AISERVICES_OPT_OUT_POLICY` | Low | Medium — increasingly relevant. Very simple structure (list of service names). |
| **Declarative policies** (EC2, VPC) | `DECLARATIVE_POLICY_EC2` | Low-medium | Low — very new (2024), limited adoption so far. |

All policy types share the same API pattern: `CreatePolicy` / `UpdatePolicy` / `DeletePolicy` / `AttachPolicy` / `DetachPolicy` / `ListPolicies` / `ListPoliciesForTarget` / `DescribePolicy`.

---

## Gaps: Organization account management

| Feature | API | Complexity | Impact |
|---------|-----|------------|--------|
| Account alternate contacts | `PutAlternateContact` / `GetAlternateContact` (billing, operations, security) | Low | Medium — CIS Benchmark requirement. Easy to add as fields on account config. |
| Account closure | `CloseAccount` | Low | Low — already on roadmap as `graveyard close`. |
| Delegated administrator | `RegisterDelegatedAdministrator` / `DeregisterDelegatedAdministrator` | Low | Medium — lets you run SSO admin from a non-management account. |

---

## Gaps: IAM Identity Center features

| Feature | API | Complexity | Impact |
|---------|-----|------------|--------|
| ABAC (access control attributes) | `CreateInstanceAccessControlAttributeConfiguration` | Low-medium | Medium — already on roadmap. Enables tag-based policies. |
| Trusted token issuers | `CreateTrustedTokenIssuer` | Medium | Low — M2M and cross-service auth. |
| Applications (SAML/OIDC) | `CreateApplication` / `CreateApplicationAssignment` | High | Low — for app integrations, not account access. |
| Multi-region replication | Instance replication APIs (2025) | High | Low — enterprise-only, complex. |

---

## Competitive landscape

| Tool | Strengths | Weaknesses vs. us |
|------|-----------|-------------------|
| **Terraform** (aws provider) | Full API coverage, mature ecosystem | Verbose HCL, no plan-from-config UX, no profile generation, no opinionated workflows |
| **OrgFormation** | CloudFormation-based, deploys resources to accounts, task pipelines | YAML-based, no TypeScript autocomplete, no IAM action helpers, heavier abstraction |
| **aws-sso-util** (Python) | Profile generation, credential helpers | Python dependency, SSO-only (no org management), unmaintained periods |
| **AWS Control Tower** | Managed guardrails, account factory | ClickOps-heavy, opaque, creates resources you don't control, expensive at scale |

---

## Priority tiers

### Tier 1 — Immediate differentiators (high impact, low-medium effort)

1. **Permission set session duration** — One field addition. Table-stakes that every user needs.
2. **`profile` command** — #1 quality-of-life feature. Eliminates need for aws-sso-util.
3. **SCPs** — The primary governance primitive. Biggest gap vs. Terraform/OrgFormation.

### Tier 2 — Strong value-add (high impact, medium effort)

4. **Tag policies** — Universal governance need. Same API pattern as SCPs (implement together).
5. **Account alternate contacts** — Simple API, CIS Benchmark compliance. Field on account config.
6. **AI services opt-out policies** — Quick win, signals the tool is current. Simple structure.
7. **`validate` command** — Fast local feedback, no AWS calls needed.

### Tier 3 — Solid additions (medium impact)

8. **RCPs** — Same API as SCPs, implement alongside.
9. **ABAC** — Unlocks tag-based permission set policies.
10. **`graveyard close`** — Trivial, completes account lifecycle.
11. **Permission set boundaries** — Niche but supported by API.
12. **Delegated administrator** — Useful for security-conscious orgs.

### Tier 4 — Long-term (lower impact or high complexity)

13. **`drift` command** — Nice for auditing.
14. **Backup policies** — Useful but niche.
15. **Well-Architected scaffolds** — Depends on SCPs being implemented first.
16. **Declarative policies** — Too new, limited adoption.
17. **Trusted token issuers / Applications** — Enterprise edge cases.

---

## README gap

The README does not explicitly state that IAM Identity Center must be enabled. The description says "AWS Organizations and IAM Identity Center" but the prerequisites section only mentions "Node.js 24+ and valid AWS credentials." Should add: "Requires an AWS Organization with IAM Identity Center enabled."
