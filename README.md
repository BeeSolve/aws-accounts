# @beesolve/aws-accounts

Local-first AWS Organizations and IAM Identity Center management CLI.

## Project docs

- Decision log for phase 1 scan: `docs/phase-1-decisions.md`
- Decision log for phase 2 bootstrap: `docs/phase-2-decisions.md`
- Agreed repository structure: `docs/repository-structure.md`

Tests compile with esbuild to `dist/*.test.js` and run with `node --test` (`npm test`).

## IAM permissions by command

Use these as inline role policies for the profile/role used by the CLI.

### `scan` permissions (read-only)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OrganizationsReadOnlyForScan",
      "Effect": "Allow",
      "Action": [
        "organizations:DescribeOrganization",
        "organizations:ListRoots",
        "organizations:ListOrganizationalUnitsForParent",
        "organizations:ListAccounts",
        "organizations:ListAccountsForParent",
        "organizations:ListParents"
      ],
      "Resource": "*"
    },
    {
      "Sid": "IdentityCenterReadOnlyForScan",
      "Effect": "Allow",
      "Action": [
        "sso:ListInstances",
        "sso:ListPermissionSets",
        "sso:DescribePermissionSet",
        "sso:ListAccountsForProvisionedPermissionSet",
        "sso:ListAccountAssignments"
      ],
      "Resource": "*"
    },
    {
      "Sid": "IdentityStoreReadOnlyForScan",
      "Effect": "Allow",
      "Action": [
        "identitystore:ListUsers",
        "identitystore:ListGroups"
      ],
      "Resource": "*"
    }
  ]
}
```

### `bootstrap` permissions (create missing Pending/Graveyard OUs only)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OrganizationsBootstrap",
      "Effect": "Allow",
      "Action": [
        "organizations:DescribeOrganization",
        "organizations:ListRoots",
        "organizations:ListOrganizationalUnitsForParent",
        "organizations:CreateOrganizationalUnit"
      ],
      "Resource": "*"
    },
    {
      "Sid": "IdentityCenterInstancesReadForBootstrap",
      "Effect": "Allow",
      "Action": ["sso:ListInstances"],
      "Resource": "*"
    }
  ]
}
```

### `create-account` permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OrganizationsCreateAccount",
      "Effect": "Allow",
      "Action": [
        "organizations:DescribeOrganization",
        "organizations:ListRoots",
        "organizations:CreateAccount",
        "organizations:DescribeCreateAccountStatus",
        "organizations:ListAccounts",
        "organizations:ListAccountsForParent"
      ],
      "Resource": "*"
    }
  ]
}
```

### `plan` permissions (local diff only)

`plan` in increment 1 is local-only (diff `aws.config.ts` vs `state.json`) and requires no AWS IAM permissions.

### `apply` permissions (OU/account placement only)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OrganizationsApplyOuPlacement",
      "Effect": "Allow",
      "Action": [
        "organizations:DescribeOrganization",
        "organizations:ListRoots",
        "organizations:ListOrganizationalUnitsForParent",
        "organizations:ListAccounts",
        "organizations:ListAccountsForParent",
        "organizations:ListParents",
        "organizations:MoveAccount"
      ],
      "Resource": "*"
    }
  ]
}
```

## Notes

- The scan output in increment 1 includes IAM Identity Center users, groups, permission sets, account assignments, and IAM role metadata from account assignment principals when available.
- If multiple IAM Identity Center instances are present, CLI should fail and require `--instance-arn`.
