# Feature Parity Research: AWS Organizations & IAM Identity Center

Research conducted May 2026. Compares current tool capabilities against available AWS APIs to identify gaps and prioritize additions. Updated to reflect v1.1.0 and v1.2.0 releases.

---

## Current coverage

### AWS Organizations (supported)

- Create, rename, delete OUs
- Move accounts between OUs
- Create and rename member accounts
- Reconcile account resource tags
- Park removed accounts in Graveyard OU
- Service Control Policies and Resource Control Policies (create/update/delete, attach/detach to roots/OUs/accounts)
- Tag policies
- AI services opt-out policies
- Account alternate contacts (billing, operations, security)

### IAM Identity Center (supported)

- Create/delete users and groups
- Update user display name and email
- Update group descriptions
- Manage group memberships
- Create/update/delete permission sets (inline policies, AWS managed policies, customer-managed policy references, session duration)
- Grant/revoke account assignments
- Reprovision changed permission sets
- ABAC (access control attributes on the Identity Center instance)

---

## Gaps: Permission set properties

| Property | API | Status | Impact |
|----------|-----|--------|--------|
| Session duration | `SessionDuration` on `CreatePermissionSet` / `UpdatePermissionSet` (ISO-8601, max 12h) | ✅ Done (v1.1.0) | **High** |
| Relay state | `RelayState` on permission set | Missing | Low — niche, sends users to a specific console page on login. |
| Permissions boundary | `PutPermissionsBoundaryToPermissionSet` | Missing (on roadmap) | Medium |
| Tags on permission sets | `TagResource` / `UntagResource` on permission set ARN | Missing | Low — useful for governance/cost allocation. |

---

## Gaps: Organization policy types

AWS Organizations supports 6 policy types.

| Policy type | API type constant | Complexity | Impact |
|-------------|-------------------|------------|--------|
| **Service Control Policies (SCPs)** | `SERVICE_CONTROL_POLICY` | Medium-high | ✅ Done (v1.1.0) |
| **Resource Control Policies (RCPs)** | `RESOURCE_CONTROL_POLICY` | Medium | ✅ Done (v1.1.0) |
| **Tag policies** | `TAG_POLICY` | Low-medium | ✅ Done (v1.1.0) |
| **Backup policies** | `BACKUP_POLICY` | Medium | Medium — centralized backup plans across accounts. |
| **AI services opt-out policies** | `AISERVICES_OPT_OUT_POLICY` | Low | ✅ Done (v1.1.0) |
| **Declarative policies** (EC2, VPC) | `DECLARATIVE_POLICY_EC2` | Low-medium | Low — very new (2024), limited adoption so far. |

All policy types share the same API pattern: `CreatePolicy` / `UpdatePolicy` / `DeletePolicy` / `AttachPolicy` / `DetachPolicy` / `ListPolicies` / `ListPoliciesForTarget` / `DescribePolicy`.

---

## Gaps: Organization account management

| Feature | API | Complexity | Impact |
|---------|-----|------------|--------|
| Account alternate contacts | `PutAlternateContact` / `GetAlternateContact` (billing, operations, security) | Low | ✅ Done (v1.2.0) |
| Account closure | `CloseAccount` | Low | ✅ Done (v1.1.0) — `graveyard close` subcommand |
| Delegated administrator | `RegisterDelegatedAdministrator` / `DeregisterDelegatedAdministrator` | Low | Medium — lets you run SSO admin from a non-management account. |

---

## Gaps: IAM Identity Center features

| Feature | API | Complexity | Impact |
|---------|-----|------------|--------|
| ABAC (access control attributes) | `CreateInstanceAccessControlAttributeConfiguration` | Low-medium | ✅ Done (v1.2.0) |
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

### Tier 1 — Immediate differentiators ✅ Complete

1. **Permission set session duration** ✅ Done (v1.1.0)
2. **`profile` command** ✅ Done (v1.1.0)
3. **SCPs / RCPs** ✅ Done (v1.1.0)

### Tier 2 — Strong value-add ✅ Complete

4. **Tag policies** ✅ Done (v1.1.0)
5. **Account alternate contacts** ✅ Done (v1.2.0)
6. **AI services opt-out policies** ✅ Done (v1.1.0)
7. **`validate` command** ✅ Done (v1.1.0)

### Tier 3 — Solid additions (partially done)

8. **RCPs** ✅ Done (v1.1.0)
9. **ABAC** ✅ Done (v1.2.0)
10. **`graveyard close`** ✅ Done (v1.1.0)
11. **Permission set boundaries** — Missing. Niche but supported by API.
12. **Delegated administrator** — Missing. Useful for security-conscious orgs.

### Tier 4 — Long-term (lower impact or high complexity)

13. **`drift` command** — Nice for auditing.
14. **Backup policies** — Useful but niche.
15. **Well-Architected scaffolds** — Depends on SCPs being implemented first.
16. **Declarative policies** — Too new, limited adoption.
17. **Trusted token issuers / Applications** — Enterprise edge cases.


---

## Control Tower / Account Factory functionality via direct APIs

Research into whether we can provide Control Tower-equivalent functionality using only AWS SDKs — no Control Tower, no CloudFormation, no StackSets dependency.

### What Control Tower actually creates

A "landing zone" is just a set of resources provisioned via standard APIs:

| CT resource | Direct API equivalent |
|-------------|----------------------|
| Security OU | `organizations:CreateOrganizationalUnit` |
| Log Archive account | `organizations:CreateAccount` + move to Security OU |
| Audit account | `organizations:CreateAccount` + move to Security OU |
| Org-wide CloudTrail | `cloudtrail:CreateTrail` with `IsOrganizationTrail: true` |
| S3 bucket for logs | `s3:CreateBucket` + bucket policy for org trail writes |
| Deny-region SCP | `organizations:CreatePolicy` + `AttachPolicy` |
| Baseline SCPs | Same pattern |
| Config recorder in member accounts | `config:PutConfigurationRecorder` (cross-account) |

All achievable via SDK calls from the management account or via `sts:AssumeRole` into member accounts.

### Account Factory replacement

What CT Account Factory does at account creation:

| Step | API | Our status |
|------|-----|------------|
| Create account | `organizations:CreateAccount` | ✅ Done |
| Move to target OU | `organizations:MoveAccount` | ✅ Done |
| Set alternate contacts | `account:PutAlternateContact` | On roadmap (Tier 2) |
| Apply SCPs via OU membership | Automatic once SCPs exist on OU | On roadmap (Tier 1) |
| Enable CloudTrail | `cloudtrail:CreateTrail` / `StartLogging` | Future |
| Enable Config recording | `config:PutConfigurationRecorder` / `StartConfigurationRecorder` | Future |
| Deploy baseline IAM roles | `iam:CreateRole` / `PutRolePolicy` | Future |
| Account-level settings | `account:PutAccountSettings`, `iam:CreateAccountAlias` | Future |

Cross-account operations use `OrganizationAccountAccessRole` — AWS automatically creates this role in every member account provisioned via `CreateAccount`.

### Controls / Guardrails mapping

CT's ~400 controls map to three mechanisms:

| Control type | CT implementation | Our equivalent |
|--------------|-------------------|----------------|
| Preventive | SCPs | `organizations:CreatePolicy` / `AttachPolicy` — on roadmap |
| Detective | AWS Config rules | `config:PutConfigRule` via cross-account assume-role — future |
| Proactive | CloudFormation hooks | Out of scope (CFN-specific) |

### Account baselines — recommended approach

Rather than deploying a custom Lambda to member accounts, the better approach is:

**Option A: Direct SDK calls for known baselines (recommended)**

Extend the existing management-account Lambda to assume role into member accounts and execute well-defined setup operations:

```ts
accountDefaults: {
  alias: "${accountName}-${orgName}",
  cloudTrail: { enabled: true },
  configRecorder: { enabled: true, deliveryBucket: "org-config-logs" },
  passwordPolicy: { minimumLength: 14, requireSymbols: true },
  blockPublicS3: true,
  ebs: { defaultEncryption: true },
}
```

Each setting maps to 1-3 SDK calls. Idempotent, fits plan/apply model, user declares desired state without writing code.

**Option B: StackSets as escape hatch for arbitrary resources**

For truly custom resources (VPCs, IAM roles, specific S3 buckets), orchestrate CloudFormation StackSets:

```ts
accountDefaults: {
  stackSets: [
    { name: "baseline-networking", template: "./templates/vpc.yaml", parameters: { CidrBlock: "10.0.0.0/16" } },
    { name: "baseline-security", template: "./templates/security-roles.yaml" },
  ],
}
```

The Lambda calls `cloudformation:CreateStackSet` + `CreateStackInstances`. StackSets handle cross-account deployment, rollback, and drift. We just orchestrate when they run.

**Why not a custom Lambda in member accounts:**

- Reinvents StackSets without rollback, drift detection, or parallel execution
- 15-minute Lambda timeout limits complex setups
- No automatic cleanup on partial failure
- Packaging burden on the user (must write idempotent handler)
- IAM permissions explosion (Lambda role needs whatever the handler requires)

### Implementation path

1. **Now:** Org structure + Identity Center (done)
2. **Next:** SCPs + tag policies + session duration (Tier 1-2)
3. **Then:** Account defaults — post-creation settings via cross-account assume-role (direct SDK calls for common baselines)
4. **Later:** Org-wide CloudTrail + Config — the "landing zone in config" story
5. **Escape hatch:** StackSets integration for arbitrary custom resources

### Positioning

**"Control Tower as code, without Control Tower."**

- Transparent: every resource is in your config file
- No opaque managed resources
- No ClickOps
- No Control Tower cost overhead (Config rules in every account, mandatory CloudTrail)
- Full plan/apply semantics with destructive operation gates
