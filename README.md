# @beesolve/aws-accounts

Local-first AWS Organizations and IAM Identity Center management CLI.

## Workflow

The tool's lifecycle has three phases:

1. **Init (one-time).** `init` runs `bootstrap` + `scan` and writes `aws.config.ts` + `aws.config.types.ts` from the resulting `state.json`. After this, AWS state is mirrored locally and `aws.config.ts` is your editable source of truth.
2. **Edit (steady state).** Edit `aws.config.ts` to model the desired state. Run `regenerate` to refresh `aws.config.types.ts` (picklists / IDE autocomplete) after manual edits. A future `watch` command will run `regenerate` automatically.
3. **Sync (phase 6 Wave 2).** `plan` shows the diff between desired (`aws.config.ts`) and actual (`state.json`); `apply` reconciles supported mutations in AWS and writes updated `state.json`.

`bootstrap` and `scan` remain individually callable for advanced or recovery use, but they are init-time commands — not part of the routine edit / sync loop. Manual changes made directly in the AWS Console outside this tool are not detected or merged in increment 1; re-run `init` (with confirmation) to reset `aws.config.ts` to current AWS state.

## Plan/apply safety

- `plan` is local-only in increment 1 and does not require AWS IAM permissions.
- `apply` recomputes the plan before executing any operations.
- `apply --yes` skips the interactive confirmation prompt.
- `apply --ignore-unsupported` proceeds only when unsupported diffs are non-destructive (`unsupportedMutation`).
- Destructive unsupported diffs always block `apply` (no override).
- If `apply` fails mid-run, the CLI persists partial `state.json`; recovery flow is: run `scan`, verify state, then re-run `apply`.

## Supported mutations

`plan` and `apply` currently support these AWS Organizations mutations:

- move account between known OUs
- create OU under a known parent OU
- rename OU when the diff resolves to a strict one-to-one same-parent rename
- create account in a known target OU

`plan` and `apply` also support these IAM Identity Center mutations:

- create missing users
- create missing groups
- create missing permission sets
- grant account assignments
- revoke account assignments

Still out of scope in the current increment:

- destructive mutations (OU/account removals)
- removing IAM Identity Center users, groups, or permission sets
- editing IAM Identity Center user metadata after creation
- editing IAM Identity Center permission set metadata after creation
- permission set policy / attachment management
- group membership management
- account metadata reconciliation after creation (tags, alternate contacts, account-name drift)

## FAQ

### I moved an account manually in AWS Console. How do I fix `aws.config.ts`?

Run:

```bash
npm run cli -- init
```

(`npm run cli -- init --yes` for non-interactive runs.)

Reason: `scan` updates only `state.json`, while `aws.config.ts` is rewritten from live AWS state only during `init`.

### Why not `scan` only?

`scan` refreshes actual state in `state.json`, but does not modify `aws.config.ts`.

### Why not `scan` + `regenerate`?

`regenerate` refreshes only `aws.config.types.ts` from the current `aws.config.ts`.  
It does not rewrite `aws.config.ts`, so stale config remains stale.

## Project docs

- Decision log for phase 1 scan: `docs/phase-1-decisions.md`
- Decision log for phase 2 bootstrap: `docs/phase-2-decisions.md`
- Decision log for phase 3 init / regenerate: `docs/phase-3-decisions.md`
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
        "sso:ListAccountsForProvisionedPermissionSet",
        "sso:ListAccountAssignments",
        "identitystore:ListUsers",
        "identitystore:ListGroups"
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
        "sso:ListAccountsForProvisionedPermissionSet",
        "sso:ListAccountAssignments",
        "identitystore:ListUsers",
        "identitystore:ListGroups"
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
        "organizations:CreateAccount",
        "organizations:DescribeCreateAccountStatus",
        "identitystore:CreateUser",
        "identitystore:CreateGroup",
        "sso:CreatePermissionSet",
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

- The scan output in increment 1 includes IAM Identity Center users, groups, permission sets, account assignments, and IAM role metadata from account assignment principals when available.
- If multiple IAM Identity Center instances are present, CLI should fail and require `--instance-arn`.
