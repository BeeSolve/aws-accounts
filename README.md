# @beesolve/aws-accounts

AWS Organizations and IAM Identity Center management CLI.

## v1 status

**v1 is complete** for the agreed scope: `bootstrap`, `scan`, `init`, `regenerate`, `plan`, `apply`, and `graveyard`, with config-driven reconciliation for Organizations (including gated destructive work such as empty OU deletes and parking removed accounts in `Graveyard`) and IAM Identity Center (assignments, permission set policies, metadata updates, and gated entity removal). Human `plan` / `apply` previews and `plan --json` (including destructive summary metadata) are supported.

**Deferred after v1:** cross-session saved plan files, automatic drift merge from the AWS Console into `aws.config.ts`, alternate account metadata (e.g. alternate contacts), and OU-level inherited default tags (see `docs/account-tag-inheritance-research.md`). Follow-ups are tracked in `docs/v1-backlog-priority.md`.

## Workflow

The tool's lifecycle has three phases:

1. **Bootstrap (one-time).** `bootstrap` deploys the remote infrastructure: S3 bucket for state, IAM role, and Lambda function. Run this once per AWS organization.
2. **Init (one-time).** `init` triggers a remote scan via Lambda, then generates `aws.config.ts` + `aws.config.types.ts` from the resulting state. After this, `aws.config.ts` is your editable source of truth.
3. **Edit (steady state).** Edit `aws.config.ts` to model the desired state. Run `regenerate` to refresh `aws.config.types.ts` (picklists / IDE autocomplete) after manual edits.
4. **Sync.** `plan` computes the diff between desired (`aws.config.ts`) and actual (remote state in S3); `apply` sends operations to Lambda for execution and writes updated state back to S3.

`scan` remains individually callable for advanced or recovery use, but it is an init-time command — not part of the routine edit / sync loop. Manual changes made directly in the AWS Console outside this tool are not detected or merged after init; re-run `init` (with confirmation) to reset `aws.config.ts` to current AWS state.

For IAM inline policies, `aws.config.types.ts` also exports `iam` helpers with
service-scoped action autocomplete:

```ts
import { awsConfigSchema, iam, type AwsConfig } from "./aws.config.types.js";

Action: [iam.s3("GetObject"), iam.identitystore("CreateGroupMembership")];
```

When `init` rewrites `aws.config.ts`, it now emits those helper expressions for
recognized IAM actions inside inline policies. `scan` still updates only
remote state in S3.
Those policy helpers and schemas are provided by the installed
`@beesolve/iam-policy-ts` package and re-exported through `aws.config.types.ts`.

## Plan/apply safety

- `plan` computes the diff using remote state fetched from S3 via Lambda.
- `apply` recomputes the plan before executing any operations.
- `apply --yes` skips the interactive confirmation prompt.
- `apply --ignore-unsupported` proceeds only when unsupported diffs are non-destructive (`unsupportedMutation`).
- `apply --allow-destructive` is required for supported destructive operations.
- Human-readable `plan` and `apply` previews mark supported destructive deletes as `[destructive]`.
- The interactive `apply` prompt explicitly warns when the pending batch includes destructive operations.
- Destructive unsupported diffs always block `apply` (no override).
- If `apply` fails mid-run, the Lambda persists partial state to S3; recovery flow is: run `scan`, verify state, then re-run `apply`.

## Supported mutations

`plan` and `apply` currently support these AWS Organizations mutations:

- move account between known OUs
- create OU under a known parent OU
- rename OU when the diff resolves to a strict one-to-one same-parent rename
- delete an OU subtree with `apply --allow-destructive` when every removed OU becomes empty and nested deletes can run deepest-first
- create account in a known target OU
- rename member accounts to match `aws.config.ts` (AWS Account Management `account:PutAccountName`; requires trusted access for Account Management on the organization). When you change an account's `name` in config, also update every `assignments` entry (and any other references) that list that account by name so the model stays consistent; the tool resolves existing members by **account id** (falling back to matching by **email** when the config name no longer matches AWS) before planning the rename.
- reconcile member account resource tags with `organizations:TagResource` / `organizations:UntagResource`
- remove accounts from authored config by moving them into the reserved `Graveyard` OU with `apply --allow-destructive` (manual AWS account closure remains required)

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

OU deletion is intentionally narrow in v1.

A removed OU can be reconciled with `deleteOu` only when all of the following are true:

- the OU is removed from `aws.config.ts`,
- every current descendant OU in that removed subtree is also removed and safely deletable,
- each OU in the subtree is either already empty in state or becomes empty through same-batch direct account moves,
- `apply` can execute the deletes deepest-first,
- live AWS preflight checks immediately before each delete confirm that no child OU or account is still attached.

These cases are still blocked:

- deleting `Graveyard`,
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

Beyond v1 (not implemented in this repo today):

- deleting an OU that still has child OUs or accounts
- deleting an OU subtree when any descendant is unresolved or unsafe to delete
- deleting the reserved `Graveyard` OU (do that manually outside this tool)
- alternate contacts and other account metadata not modeled in `aws.config.ts` (tags and member account display names are reconciled when authored in config; see `docs/v1-backlog-priority.md`)
- Terraform-style saved plan artifacts

`Graveyard` is bootstrap-managed internal state. Generated `aws.config.ts` intentionally omits `Graveyard` accounts and does not require a `Graveyard` OU entry.

## Recovery after failed destructive apply

If `apply --allow-destructive` fails after some operations succeeded, the Lambda writes the progressed state to S3 before returning the error.

Recovery flow:

1. Run `npm run cli -- scan` to refresh remote state from live AWS.
2. Review the plan with `npm run cli -- plan`.
3. If the remaining diff is still intended, rerun `npm run cli -- apply --allow-destructive`.

Do not blindly rerun `apply` without `scan` after a partial destructive failure; the live AWS state may already differ from the old plan.

## FAQ

### I moved an account manually in AWS Console. How do I fix `aws.config.ts`?

Run:

```bash
npm run cli -- init
```

(`npm run cli -- init --yes` for non-interactive runs.)

Reason: `scan` updates only remote state in S3, while `aws.config.ts` is rewritten from live AWS state only during `init`.
When possible, the generated inline policy actions are rendered back as
`iam.*(...)` helper calls instead of raw strings.

### Why not `scan` only?

`scan` refreshes actual state in S3, but does not modify `aws.config.ts`.

### Why not `scan` + `regenerate`?

`regenerate` refreshes only `aws.config.types.ts` from the current `aws.config.ts`.  
It does not rewrite `aws.config.ts`, so stale config remains stale.

IAM action hint data and policy schemas come from the installed
`@beesolve/iam-policy-ts` package rather than a repository-local generated
catalog.

## Project docs

- Decision log for phase 1 scan: `docs/phase-1-decisions.md`
- Decision log for phase 2 bootstrap: `docs/phase-2-decisions.md`
- Architecture and technology choices: `docs/adr/002-architecture-and-technology-choices.md`
- V1 implementation phases: `docs/adr/003-v1-implementation-phases.md`
- Remove local execution model: `docs/adr/001-remove-local-execution-model.md`
- Post-v1 backlog and deferred ideas: `docs/v1-backlog-priority.md`
- Repository structure and conventions: `docs/repository-structure.md`
- Account tag inheritance research: `docs/account-tag-inheritance-research.md`

Tests compile with esbuild to `dist/*.test.js` and run with `node --test` (`npm test`).

## IAM permissions

The CLI delegates all AWS operations to a deployed Lambda function. IAM permissions are split into two tiers:

### Routine usage (scan, plan, apply, init)

These commands only invoke the Lambda function. The Lambda's own execution role handles Organizations, Identity Center, and S3 access.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RoutineCliUsage",
      "Effect": "Allow",
      "Action": "lambda:InvokeFunction",
      "Resource": "arn:aws:lambda:*:*:function:beesolve-aws-accounts"
    }
  ]
}
```

### Infrastructure provisioning (bootstrap, upgrade)

`bootstrap` deploys the Lambda, S3 bucket, and IAM role. `upgrade` updates the Lambda function code. These commands require broader permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BootstrapInfrastructure",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity",
        "s3:CreateBucket",
        "s3:PutBucketTagging",
        "iam:GetRole",
        "iam:CreateRole",
        "iam:TagRole",
        "iam:PutRolePolicy",
        "iam:PassRole",
        "lambda:GetFunction",
        "lambda:CreateFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:TagResource",
        "lambda:PutFunctionConcurrency",
        "sso:ListPermissionSets",
        "sso:DescribePermissionSet",
        "sso:CreatePermissionSet",
        "sso:UpdatePermissionSet",
        "sso:PutInlinePolicyToPermissionSet",
        "sso:TagResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "UpgradeLambdaCode",
      "Effect": "Allow",
      "Action": "lambda:UpdateFunctionCode",
      "Resource": "arn:aws:lambda:*:*:function:beesolve-aws-accounts"
    }
  ]
}
```

**Notes on commands not in this policy:**
- `regenerate` performs local code generation only (no AWS API calls); no permissions required.
- `graveyard` reads the local remote state cache only (no AWS API calls); no permissions required.

## Notes

- The scan output includes IAM Identity Center users, groups, group memberships, permission sets, permission set policy attachments, account assignments, and IAM role metadata from account assignment principals when available.
- If multiple IAM Identity Center instances are present, CLI should fail and require `--instance-arn`.
