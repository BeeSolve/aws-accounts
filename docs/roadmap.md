# Roadmap

Post-v1 features under consideration. Not committed to a timeline.

---

## 1. `profile` command — generate AWS CLI profiles

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

---

## 2. ABAC — Attributes for Access Control

Define attribute mappings on the Identity Center instance that enable `${aws:PrincipalTag/key}` conditions in permission set policies.

**API surface:**

- `CreateInstanceAccessControlAttributeConfiguration` — enable ABAC and define mappings
- `UpdateInstanceAccessControlAttributeConfiguration` — modify mappings
- `DescribeInstanceAccessControlAttributeConfiguration` — read current config
- `DeleteInstanceAccessControlAttributeConfiguration` — disable ABAC

**Proposed config model:**

```ts
identityCenter: {
  accessControlAttributes: [
    { key: "department", source: ["${path:enterprise.department}"] },
    { key: "costCenter", source: ["${path:enterprise.costCenter}"] },
  ],
}
```

Scan reads current ABAC config, plan/apply reconciles attribute mappings.

**Complexity:** Low-medium. Simple key/source[] array structure.

---

## 3. Organization Policies — SCPs and RCPs

Manage Service Control Policies and Resource Control Policies attached to OUs and accounts.

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

---

## 4. `graveyard close` — generate account closure commands

Output AWS CLI commands for closing graveyarded accounts:

```bash
aws organizations close-account --account-id 123456789012
```

Low effort, completes the account lifecycle story.

---

## 5. `validate` command — local config validation

Check `aws.config.ts` for common mistakes without hitting AWS:

- Duplicate account/OU/group/user names
- Assignments referencing non-existent permission sets or groups
- Invalid policy syntax or size violations
- Circular or conflicting references

Fast local feedback loop before plan/apply.

---

## 6. `drift` command — detect manual AWS changes

Compare current remote state against last-known state to show what changed in AWS since last scan. Useful for auditing manual console changes before deciding whether to `init` (reset config) or `plan` (push config).

---

## 7. Permission set boundaries

Support `PermissionsBoundary` on permission sets (AWS managed or customer-managed policy ARN). Already supported by the SSO Admin API, just not modeled in config yet.

---

## 8. Well-Architected patterns — opinionated org scaffolding

Provide commands that provision recommended OU structures and guardrails based on AWS Well-Architected best practices.

**Phase 1: `scaffold sandbox`** — create a Sandbox OU with a pre-configured SCP that limits blast radius (e.g., deny expensive services, restrict regions). Useful for safely testing SCPs before promoting them to production OUs.

```bash
npx aws-accounts scaffold sandbox --name "SCP-Testing" --regions eu-central-1,us-east-1
```

Would generate:

- A `Sandbox` OU (or custom name) under root
- A restrictive SCP attached to it (deny region sprawl, deny costly services)
- Optionally a test account moved into the OU

**Phase 2:** Additional scaffolds for common patterns:

- `scaffold workloads` — Production / Staging / Dev OU hierarchy with graduated SCPs
- `scaffold security` — Security OU with log archive and audit accounts
- `scaffold governance` — Shared Services OU with networking and identity accounts

**Key considerations:**

- Scaffolds are additive — they don't touch existing OUs/accounts
- Generated config is fully editable after scaffolding (no magic, just config)
- Depends on Organization Policies (item 3) for SCP attachment
- Should reference AWS Control Tower / Landing Zone patterns without reimplementing them

---

## Suggested priority

1. `profile` — immediate user value, low effort
2. `graveyard close` — trivial, completes existing workflow
3. `validate` — fast feedback, no AWS calls
4. ABAC — unlocks tag-based policies
5. Organization Policies (SCPs/RCPs) — high value but higher complexity
6. `drift` — nice-to-have for auditing
7. Permission set boundaries — niche, low urgency
8. Well-Architected scaffolds — depends on SCPs, longer-term
