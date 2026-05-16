# @beesolve/aws-accounts

[![npm version](https://img.shields.io/npm/v/@beesolve/aws-accounts)](https://www.npmjs.com/package/@beesolve/aws-accounts)
[![license](https://img.shields.io/npm/l/@beesolve/aws-accounts)](./LICENSE)

Config-driven management for AWS Organizations and IAM Identity Center. Define your org structure, accounts, permission sets, and access assignments in a single TypeScript file — then `plan` and `apply` changes like Terraform.

## Installation

```bash
npm install @beesolve/aws-accounts
```

Requires Node.js 24+ and valid AWS credentials (via environment, profile, or SSO).

## Quick Start

```bash
# 1. Create a project directory
mkdir my-org && cd my-org
npm init -y
npm pkg set type=module
npm install @beesolve/aws-accounts

# 2. Deploy remote infrastructure (S3 bucket, IAM role, Lambda)
npx aws-accounts bootstrap --region us-east-1

# 3. Scan your AWS org and generate aws.config.ts
npx aws-accounts init

# 4. Edit aws.config.ts to model your desired state

# 5. Preview and apply changes
npx aws-accounts plan
npx aws-accounts apply
```

After `init`, `aws.config.ts` is your source of truth. Edit it to add accounts, move OUs, manage permission sets, and control access — then sync with `plan` / `apply`.

## Commands

| Command | Description |
|---------|-------------|
| `bootstrap` | One-time setup: deploys S3 bucket, IAM role, and Lambda to your AWS account |
| `init` | Scans live AWS state and generates `aws.config.ts` + `aws.config.types.ts` |
| `regenerate` | Refreshes `aws.config.types.ts` (picklists, autocomplete) from current config |
| `plan` | Computes diff between desired config and actual AWS state |
| `apply` | Executes planned operations via Lambda |
| `upgrade` | Updates the deployed Lambda function code |
| `scan` | Refreshes remote state in S3 (advanced/recovery use) |
| `graveyard` | Lists accounts parked in the Graveyard OU |

## Workflow

The tool has four phases:

1. **Bootstrap** (one-time) — `bootstrap` deploys the remote infrastructure. Run once per AWS organization.
2. **Init** (one-time) — `init` scans your org and generates the config files. After this, `aws.config.ts` is your editable source of truth.
3. **Edit** (steady state) — modify `aws.config.ts` to model your desired org structure. Run `regenerate` to refresh IDE autocomplete after edits.
4. **Sync** — `plan` shows what will change; `apply` executes it.

## Configuration

After `init`, your project contains:

- **`aws.config.ts`** — your desired state: OUs, accounts, users, groups, permission sets, assignments
- **`aws.config.types.ts`** — generated types and helpers for IDE autocomplete

### IAM Policy Helpers

`aws.config.types.ts` exports `iam` helpers with service-scoped action autocomplete:

```ts
import { awsConfigSchema, iam, type AwsConfig } from "./aws.config.types.js";

// Full autocomplete for IAM actions
Action: [iam.s3("GetObject"), iam.identitystore("CreateGroupMembership")]
```

When `init` generates your config, recognized IAM actions in inline policies are emitted as helper calls rather than raw strings.

## Supported Mutations

### AWS Organizations

- Create, rename, and delete OUs (delete requires `--allow-destructive`)
- Move accounts between OUs
- Create and rename member accounts
- Reconcile account resource tags
- Park removed accounts in a `Graveyard` OU (`--allow-destructive`)

### IAM Identity Center

- Create and delete users and groups
- Update user display name and email
- Update group descriptions
- Manage group memberships
- Create, update, and delete permission sets
- Manage inline policies, AWS managed policies, and customer-managed policy references
- Grant and revoke account assignments
- Reprovision changed permission sets

## Plan/Apply Safety

- `plan` fetches current remote state from S3 before computing the diff.
- `apply` recomputes the plan before executing — no stale operations.
- Destructive operations (OU deletion, entity removal) require `--allow-destructive`.
- `--ignore-unsupported` proceeds only for non-destructive unsupported diffs.
- Destructive unsupported diffs always block `apply` (no override).
- Human-readable previews mark destructive operations explicitly.

### Example: destructive apply

```bash
npx aws-accounts plan
npx aws-accounts apply --allow-destructive
```

```text
Plan: 3 operation(s), 0 unsupported diff(s)
Destructive operations detected: 1. Apply requires --allow-destructive.
  remove user "alice" from IdC group "Admins"
  revoke IdC assignment "AdminAccess" from group "Admins" on "AppAccount"
  [destructive] delete IdC group "Admins"
```

### Recovery after failed apply

If `apply` fails mid-run, the Lambda persists partial state to S3. Recovery:

```bash
npx aws-accounts scan        # refresh state from live AWS
npx aws-accounts plan        # review remaining diff
npx aws-accounts apply       # re-apply (add --allow-destructive if needed)
```

## CLI Options

```
npx aws-accounts <command> [options]

Options:
  --profile <name>       AWS profile (fallback: AWS_PROFILE)
  --region <region>      AWS region (fallback: AWS_REGION, AWS_DEFAULT_REGION)
  --yes                  Skip interactive confirmations
  --json                 Output plan as JSON (plan command)
  --allow-destructive    Allow destructive operations (apply command)
  --ignore-unsupported   Proceed with non-destructive unsupported diffs (apply command)
  --refresh              Force state refresh before planning (plan command)
  --help                 Show help
```

## IAM Permissions

The CLI delegates all AWS operations to a deployed Lambda. Day-to-day usage requires only Lambda invoke permission:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "lambda:InvokeFunction",
    "Resource": "arn:aws:lambda:*:*:function:beesolve-aws-accounts"
  }]
}
```

`bootstrap` and `upgrade` require broader permissions for deploying infrastructure (S3, IAM, Lambda, SSO). See the full policy in the [docs](./docs/adr/002-architecture-and-technology-choices.md).

Commands that need no AWS permissions: `regenerate` (local codegen only), `graveyard` (reads local cache only).

## FAQ

### I moved an account manually in the AWS Console. How do I fix my config?

Run `npx aws-accounts init` (or `npx aws-accounts init --yes` for non-interactive). This rewrites `aws.config.ts` from live AWS state.

`scan` alone won't help — it refreshes remote state in S3 but doesn't touch your config file.

### What happens if I run `scan` + `regenerate`?

`regenerate` refreshes only `aws.config.types.ts` from the current `aws.config.ts`. It doesn't rewrite config, so stale config stays stale. Use `init` to reset config to live state.

### Multiple Identity Center instances?

If multiple instances exist, the CLI will fail and require `--instance-arn`.

## License

[MIT](./LICENSE)
