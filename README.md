# @beesolve/aws-accounts

Local-first AWS Organizations and IAM Identity Center management CLI.

## Workflow

The tool's lifecycle has three phases:

1. **Init (one-time).** `init` runs `bootstrap` + `scan` and writes `aws.config.ts` + `aws.config.types.ts` from the resulting `state.json`. After this, AWS state is mirrored locally and `aws.config.ts` is your editable source of truth.
2. **Edit (steady state).** Edit `aws.config.ts` to model the desired state. Run `regenerate` to refresh `aws.config.types.ts` (picklists / IDE autocomplete) after manual edits. A future `watch` command will run `regenerate` automatically.
3. **Sync (phase 5).** `plan` shows the diff between desired (`aws.config.ts`) and actual (`state.json`); `apply` reconciles supported mutations in AWS and writes updated `state.json`.

`bootstrap` and `scan` remain individually callable for advanced or recovery use, but they are init-time commands — not part of the routine edit / sync loop. Manual changes made directly in the AWS Console outside this tool are not detected or merged in increment 1; re-run `init` (with confirmation) to reset `aws.config.ts` to current AWS state.

## Plan/apply safety

- `plan` is local-only in increment 1 and does not require AWS IAM permissions.
- `apply` recomputes the plan before executing any operations.
- `apply --yes` skips the interactive confirmation prompt.
- `apply --ignore-unsupported` proceeds only when unsupported diffs are non-destructive (`unsupportedMutation`).
- Destructive unsupported diffs always block `apply` (no override).
- If `apply` fails mid-run, the CLI persists partial `state.json`; recovery flow is: run `scan`, verify state, then re-run `apply`.

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
        "organizations:MoveAccount"
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
