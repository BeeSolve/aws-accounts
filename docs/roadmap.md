# Roadmap

Post-v1 features organized by priority tier. See [feature-parity-research.md](./feature-parity-research.md) for the full analysis.

---

## Tier 1 — Immediate differentiators

### Permission set session duration

Add `sessionDuration` field to permission set config. The default 1h is too short for most workflows — this is table-stakes.

```ts
permissionSets: [
  {
    name: "AdminAccess",
    description: "Admin",
    sessionDuration: "PT8H", // ISO-8601, max 12h
    // ...
  },
]
```

**Effort:** Trivial — one field on create/update, one field in scan.

---

### `profile` command — generate AWS CLI profiles

Generate `~/.aws/config` profile blocks from account/permission-set assignments.

**Phase 1:** Interactive picker — list all account/permission-set combinations from state, user selects one, output the profile block to stdout:

```ini
[profile my-org-dev-admin]
sso_session = my-org
sso_account_id = 123456789012
sso_role_name = AdminAccess

[sso-session my-org]
sso_start_url = https://d-xxxxxxxxxx.awsapps.com/start
sso_region = eu-central-1
sso_registration_scopes = sso:account:access
```

**Phase 2:** Read existing `~/.aws/config`, detect conflicts, offer to append or update the file directly.

**Effort:** Low. Eliminates need for `aws-sso-util` (Python).

---

### Organization Policies — SCPs and RCPs

Manage Service Control Policies and Resource Control Policies attached to OUs and accounts. The #1 governance primitive — biggest gap vs. Terraform/OrgFormation.

**API surface:**

- `CreatePolicy` / `UpdatePolicy` / `DeletePolicy` (type: `SERVICE_CONTROL_POLICY` or `RESOURCE_CONTROL_POLICY`)
- `AttachPolicy` / `DetachPolicy` (target: root, OU, or account)
- `ListPolicies` / `ListPoliciesForTarget` / `DescribePolicy`

**Proposed config model:**

```ts
policies: {
  serviceControlPolicies: [
    {
      name: "DenyLeaveOrg",
      description: "Prevent accounts from leaving the organization",
      content: { Version: "2012-10-17", Statement: [...] },
      targets: ["Engineering", "Production"],  // OU names or account names
    },
  ],
  resourceControlPolicies: [
    {
      name: "RestrictS3Public",
      description: "Block public S3 access",
      content: { ... },
      targets: ["Production"],
    },
  ],
}
```

**Key considerations:**

- SCPs have inheritance (child OUs inherit parent policies)
- Every root/OU/account must keep at least one SCP attached (can't detach the last one)
- The default `FullAWSAccess` SCP must be handled carefully
- Policy content is JSON with a 5120-byte size limit for SCPs
- Destructive gate needed for policy detach/delete (could lock out accounts)
- RCPs are newer (2024) and follow the same API pattern but control resource-level access

**Phases:**

1. Scan existing SCPs/RCPs and their attachments into state
2. Plan/apply for create, update content, attach/detach
3. Destructive delete with safety checks (ensure FullAWSAccess remains)

**Effort:** Medium-high. High value.

---

## Tier 2 — Strong value-add

### Tag policies

Enforce tag standardization org-wide. Same API pattern as SCPs (`CreatePolicy` type `TAG_POLICY`). Universal governance need — often the first policy type orgs enable after SCPs.

```ts
policies: {
  tagPolicies: [
    {
      name: "CostAllocationTags",
      description: "Enforce cost allocation tags",
      content: { tags: { CostCenter: { tag_key: { "@@assign": "CostCenter" } } } },
      targets: ["Production", "Engineering"],
    },
  ],
}
```

**Effort:** Low-medium (same API as SCPs — implement together).

---

### Account alternate contacts

Manage billing, operations, and security contacts per account. Satisfies CIS AWS Foundations Benchmark 1.1/1.2.

```ts
accounts: [
  {
    name: "Production",
    email: "prod@example.com",
    alternateContacts: {
      billing: { name: "Finance Team", email: "billing@example.com", phone: "+1..." },
      operations: { name: "Ops Team", email: "ops@example.com", phone: "+1..." },
      security: { name: "Security Team", email: "security@example.com", phone: "+1..." },
    },
  },
]
```

**Effort:** Low. Simple API (`PutAlternateContact` / `GetAlternateContact`).

---

### AI services opt-out policies

Opt out of AWS AI service data usage for training. Increasingly relevant, very simple structure.

```ts
policies: {
  aiOptOutPolicies: [
    {
      name: "OptOutAll",
      description: "Opt out of all AI service data usage",
      content: { services: { default: { opt_out_policy: { "@@assign": "optOut" } } } },
      targets: ["root"],
    },
  ],
}
```

**Effort:** Low (same API pattern as other policies).

---

### `validate` command — local config validation

Check `aws.config.ts` for common mistakes without hitting AWS:

- Duplicate account/OU/group/user names
- Assignments referencing non-existent permission sets or groups
- Invalid policy syntax or size violations (SCP 5120-byte limit)
- Circular or conflicting references

Fast local feedback loop before plan/apply.

**Effort:** Low-medium. No AWS calls needed.

---

## Tier 3 — Solid additions

### ABAC — Attributes for Access Control

Define attribute mappings on the Identity Center instance that enable `${aws:PrincipalTag/key}` conditions in permission set policies.

```ts
identityCenter: {
  accessControlAttributes: [
    { key: "department", source: ["${path:enterprise.department}"] },
    { key: "costCenter", source: ["${path:enterprise.costCenter}"] },
  ],
}
```

**Effort:** Low-medium. Simple key/source[] array structure.

---

### `graveyard close` — generate account closure commands

Output AWS CLI commands for closing graveyarded accounts:

```bash
aws organizations close-account --account-id 123456789012
```

**Effort:** Trivial. Completes the account lifecycle story.

---

### Permission set boundaries

Support `PermissionsBoundary` on permission sets (AWS managed or customer-managed policy ARN). Already supported by the SSO Admin API, just not modeled in config yet.

**Effort:** Low.

---

### Delegated administrator

Register/deregister member accounts as delegated administrators for services (SSO, Organizations, etc.). Useful for security-conscious orgs that avoid running from the management account.

**Effort:** Low.

---

## Tier 4 — Long-term

### `drift` command — detect manual AWS changes

Compare current remote state against last-known state to show what changed in AWS since last scan. Useful for auditing manual console changes before deciding whether to `init` (reset config) or `plan` (push config).

---

### Backup policies

Centralized backup plans across accounts. Same API pattern as other org policies.

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
