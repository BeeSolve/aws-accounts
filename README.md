# @beesolve/aws-accounts

Local-first AWS Organizations and IAM Identity Center management CLI.

## Workflow

The tool's lifecycle has three phases:

1. **Init (one-time).** `init` runs `bootstrap` + `scan` and writes `aws.config.ts` + `aws.config.types.ts` from the resulting `state.json`. After this, AWS state is mirrored locally and `aws.config.ts` is your editable source of truth.
2. **Edit (steady state).** Edit `aws.config.ts` to model the desired state. Run `regenerate` to refresh `aws.config.types.ts` (picklists / IDE autocomplete) after manual edits. A future `watch` command will run `regenerate` automatically.
3. **Sync (phase 6 through Wave 6).** `plan` shows the diff between desired (`aws.config.ts`) and actual (`state.json`); `apply` reconciles supported mutations in AWS and writes updated `state.json`.

`bootstrap` and `scan` remain individually callable for advanced or recovery use, but they are init-time commands — not part of the routine edit / sync loop. Manual changes made directly in the AWS Console outside this tool are not detected or merged in increment 1; re-run `init` (with confirmation) to reset `aws.config.ts` to current AWS state.

For IAM inline policies, `aws.config.types.ts` also exports `iam` helpers with
service-scoped action autocomplete:

```ts
import { awsConfigSchema, iam, type AwsConfig } from "./aws.config.types.js";

Action: [iam.s3("GetObject"), iam.identitystore("CreateGroupMembership")];
```

When `init` rewrites `aws.config.ts`, it now emits those helper expressions for
recognized IAM actions inside inline policies. `scan` still updates only
`state.json`.
Those policy helpers and schemas are provided by the installed
`@beesolve/iam-policy-ts` package and re-exported through `aws.config.types.ts`.

## Plan/apply safety

- `plan` is local-only in increment 1 and does not require AWS IAM permissions.
- `apply` recomputes the plan before executing any operations.
- `apply --yes` skips the interactive confirmation prompt.
- `apply --ignore-unsupported` proceeds only when unsupported diffs are non-destructive (`unsupportedMutation`).
- `apply --allow-destructive` is required for supported destructive operations.
- Human-readable `plan` and `apply` previews mark supported destructive deletes as `[destructive]`.
- The interactive `apply` prompt explicitly warns when the pending batch includes destructive operations.
- Destructive unsupported diffs always block `apply` (no override).
- If `apply` fails mid-run, the CLI persists partial `state.json`; recovery flow is: run `scan`, verify state, then re-run `apply`.

## Supported mutations

`plan` and `apply` currently support these AWS Organizations mutations:

- move account between known OUs
- create OU under a known parent OU
- rename OU when the diff resolves to a strict one-to-one same-parent rename
- delete an OU subtree with `apply --allow-destructive` when every removed OU becomes empty and nested deletes can run deepest-first
- create account in a known target OU

`plan` and `apply` also support these IAM Identity Center mutations:

- create missing users
- create missing groups (optional non-empty description)
- update user display name and primary Work email (email updates apply only when the desired email is non-empty; clearing email in config alone is not reconciled)
- update group description
- add missing group memberships
- remove stale group memberships
- create missing permission sets
- update permission set description (when that permission set has desired account assignments, a reprovision to all provisioned accounts is included in the plan)
- delete removed users with `apply --allow-destructive`
- delete removed groups with `apply --allow-destructive`
- delete removed permission sets with `apply --allow-destructive`
- put or delete permission set inline policies
- attach or detach permission set AWS managed policies
- attach or detach permission set customer-managed policy references
- reprovision changed permission sets to all provisioned accounts
- grant account assignments
- revoke account assignments

## Safe OU deletion boundary

OU deletion is intentionally narrow in the current increment.

A removed OU can be reconciled with `deleteOu` only when all of the following are true:

- the OU is removed from `aws.config.ts`,
- every current descendant OU in that removed subtree is also removed and safely deletable,
- each OU in the subtree is either already empty in `state.json` or becomes empty through same-batch direct account moves,
- `apply` can execute the deletes deepest-first,
- live AWS preflight checks immediately before each delete confirm that no child OU or account is still attached.

These cases are still blocked:

- deleting `Pending` or `Graveyard`,
- deleting an OU subtree when any descendant is unresolved or not being removed,
- deleting an OU that still has live child OUs or live accounts,
- deleting accounts themselves.

## Example: destructive apply

If you remove an empty OU subtree from `aws.config.ts`, the normal flow is:

```bash
npm run cli -- plan
npm run cli -- apply --allow-destructive
```

You should expect the preview to call the delete out explicitly, for example:

```text
Plan: 1 operation(s), 0 unsupported diff(s)
Destructive operations detected: 1. Apply requires --allow-destructive.
  [destructive] delete OU "Engineering" from root
```

And the matching apply preview:

```text
Apply: 1 operation(s), 0 unsupported diff(s)
WARNING: this apply includes destructive operations. Review carefully before confirming.
  [destructive] delete OU "Engineering" from root
```

If you remove IAM Identity Center entities from `aws.config.ts`, the same
destructive gate applies:

```bash
npm run cli -- plan
npm run cli -- apply --allow-destructive
```

For example, if you remove a group that still has memberships and assignments,
the preview should show the prerequisite cleanup before the final delete:

```text
Plan: 3 operation(s), 0 unsupported diff(s)
Destructive operations detected: 1. Apply requires --allow-destructive.
  remove user "alice" from IdC group "Admins"
  revoke IdC assignment "AdminAccess" from group "Admins" on "AppAccount"
  [destructive] delete IdC group "Admins"
```

Still out of scope in the current increment:

- account removals
- deleting an OU that still has child OUs or accounts
- deleting an OU subtree when any descendant is unresolved or unsafe to delete
- deleting the reserved `Pending` or `Graveyard` OUs (do that manually outside this tool)
- account metadata reconciliation after creation (tags, alternate contacts, account-name drift)

## Recovery after failed destructive apply

If `apply --allow-destructive` fails after some operations succeeded, the CLI writes the progressed `state.json` before exiting.

Recovery flow:

1. Run `npm run cli -- scan` to refresh local state from live AWS.
2. Review the resulting `state.json` and rerun `npm run cli -- plan`.
3. If the remaining diff is still intended, rerun `npm run cli -- apply --allow-destructive`.

Do not blindly rerun `apply` without `scan` after a partial destructive failure; the live AWS state may already differ from the old local plan.

## FAQ

### I moved an account manually in AWS Console. How do I fix `aws.config.ts`?

Run:

```bash
npm run cli -- init
```

(`npm run cli -- init --yes` for non-interactive runs.)

Reason: `scan` updates only `state.json`, while `aws.config.ts` is rewritten from live AWS state only during `init`.
When possible, the generated inline policy actions are rendered back as
`iam.*(...)` helper calls instead of raw strings.

### Why not `scan` only?

`scan` refreshes actual state in `state.json`, but does not modify `aws.config.ts`.

### Why not `scan` + `regenerate`?

`regenerate` refreshes only `aws.config.types.ts` from the current `aws.config.ts`.  
It does not rewrite `aws.config.ts`, so stale config remains stale.

IAM action hint data and policy schemas come from the installed
`@beesolve/iam-policy-ts` package rather than a repository-local generated
catalog.

## Project docs

- Decision log for phase 1 scan: `docs/phase-1-decisions.md`
- Decision log for phase 2 bootstrap: `docs/phase-2-decisions.md`
- Decision log for phase 3 init / regenerate: `docs/phase-3-decisions.md`
- Wave 4 permission set policy plan: `docs/phase-6-wave-4-permission-set-policy-plan.md`
- Wave 4 IAM action hinting follow-up plan: `docs/phase-6-wave-4-iam-action-hints-plan.md`
- Wave 5 IdC entity removal plan: `docs/phase-6-wave-5-idc-removal-plan.md`
- Wave 6 IdC metadata updates (shipped): `docs/phase-6-wave-6-idc-metadata-updates.md`
- Current v1 backlog (remaining work after Wave 6): `docs/v1-backlog-priority.md`
- Agreed repository structure: `docs/repository-structure.md`

Tests compile with esbuild to `dist/*.test.js` and run with `node --test` (`npm test`).

## IAM permissions by command

Use this policy as an inline role policy for the profile/role used by the CLI. Each statement corresponds to a CLI command; developers can enable only the statements needed for their workflow.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ScanCommand",
      "Effect": "Allow",
      "Action": [
        "organizations:ListRoots",
        "organizations:ListAccounts",
        "organizations:ListParents",
        "organizations:ListOrganizationalUnitsForParent",
        "sso:ListInstances",
        "sso:ListPermissionSets",
        "sso:DescribePermissionSet",
        "sso:GetInlinePolicyForPermissionSet",
        "sso:ListManagedPoliciesInPermissionSet",
        "sso:ListCustomerManagedPolicyReferencesInPermissionSet",
        "sso:ListAccountsForProvisionedPermissionSet",
        "sso:ListAccountAssignments",
        "identitystore:ListUsers",
        "identitystore:ListGroups",
        "identitystore:ListGroupMemberships"
      ],
      "Resource": "*"
    },
    {
      "Sid": "BootstrapCommand",
      "Effect": "Allow",
      "Action": [
        "organizations:DescribeOrganization",
        "organizations:ListRoots",
        "organizations:ListOrganizationalUnitsForParent",
        "organizations:CreateOrganizationalUnit",
        "sso:ListInstances"
      ],
      "Resource": "*"
    },
    {
      "Sid": "InitCommand",
      "Effect": "Allow",
      "Action": [
        "organizations:DescribeOrganization",
        "organizations:ListRoots",
        "organizations:ListAccounts",
        "organizations:ListParents",
        "organizations:ListOrganizationalUnitsForParent",
        "organizations:CreateOrganizationalUnit",
        "sso:ListInstances",
        "sso:ListPermissionSets",
        "sso:DescribePermissionSet",
        "sso:GetInlinePolicyForPermissionSet",
        "sso:ListManagedPoliciesInPermissionSet",
        "sso:ListCustomerManagedPolicyReferencesInPermissionSet",
        "sso:ListAccountsForProvisionedPermissionSet",
        "sso:ListAccountAssignments",
        "identitystore:ListUsers",
        "identitystore:ListGroups",
        "identitystore:ListGroupMemberships"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CreateAccountCommand",
      "Effect": "Allow",
      "Action": [
        "organizations:ListAccounts",
        "organizations:CreateAccount",
        "organizations:DescribeCreateAccountStatus",
        "organizations:MoveAccount"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ApplyCommand",
      "Effect": "Allow",
      "Action": [
        "organizations:ListAccounts",
        "organizations:MoveAccount",
        "organizations:CreateOrganizationalUnit",
        "organizations:UpdateOrganizationalUnit",
        "organizations:DeleteOrganizationalUnit",
        "organizations:ListAccountsForParent",
        "organizations:ListOrganizationalUnitsForParent",
        "organizations:CreateAccount",
        "organizations:DescribeCreateAccountStatus",
        "identitystore:CreateUser",
        "identitystore:CreateGroup",
        "identitystore:CreateGroupMembership",
        "identitystore:DeleteUser",
        "identitystore:DeleteGroup",
        "identitystore:DeleteGroupMembership",
        "identitystore:GetGroupMembershipId",
        "identitystore:UpdateGroup",
        "identitystore:UpdateUser",
        "sso:CreatePermissionSet",
        "sso:DeletePermissionSet",
        "sso:UpdatePermissionSet",
        "sso:PutInlinePolicyToPermissionSet",
        "sso:DeleteInlinePolicyFromPermissionSet",
        "sso:AttachManagedPolicyToPermissionSet",
        "sso:DetachManagedPolicyFromPermissionSet",
        "sso:AttachCustomerManagedPolicyReferenceToPermissionSet",
        "sso:DetachCustomerManagedPolicyReferenceFromPermissionSet",
        "sso:ProvisionPermissionSet",
        "sso:DescribePermissionSetProvisioningStatus",
        "sso:CreateAccountAssignment",
        "sso:DeleteAccountAssignment",
        "sso:DescribeAccountAssignmentCreationStatus",
        "sso:DescribeAccountAssignmentDeletionStatus"
      ],
      "Resource": "*"
    }
  ]
}
```

**Notes on commands not in this policy:**
- `regenerate` performs local code generation only (no AWS API calls); no permissions required.
- `plan` compares local config against state file (no AWS API calls); no permissions required.

## Notes

- The scan output in the current increment includes IAM Identity Center users, groups, group memberships, permission sets, permission set policy attachments, account assignments, and IAM role metadata from account assignment principals when available.
- If multiple IAM Identity Center instances are present, CLI should fail and require `--instance-arn`.
