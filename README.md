# @beesolve/aws-accounts

[![npm version](https://img.shields.io/npm/v/@beesolve/aws-accounts)](https://www.npmjs.com/package/@beesolve/aws-accounts)
[![license](https://img.shields.io/npm/l/@beesolve/aws-accounts)](./LICENSE)

Config-driven management for AWS Organizations and IAM Identity Center. Define your org structure, accounts, permission sets, and access assignments in a single TypeScript file — then `plan` and `apply` changes like Terraform.

## Getting Started

### Path A: Fresh AWS Account (no organization yet)

Don't have an AWS account? [Create one here](https://portal.aws.amazon.com/billing/signup).

```bash
mkdir my-org && cd my-org
npm init -y && npm pkg set type=module
npm install @beesolve/aws-accounts typescript
git init && echo -e "node_modules/\n.remote-state-cache.json" > .gitignore

# Bootstrap handles everything: creates the Organization,
# guides you through enabling Identity Center, deploys infrastructure
npx aws-accounts bootstrap --region us-east-1

# Scan your org and generate the config file
npx aws-accounts init

# Edit aws.config.ts, then sync
npx aws-accounts plan
npx aws-accounts apply
```

The CLI will:
1. Detect no Organization exists and offer to create one (all features enabled)
2. Detect Identity Center is not enabled and provide Console instructions
3. Deploy the remote infrastructure (S3 bucket, IAM role, Lambda)

### Path B: Existing Organization

Prerequisites:
- **AWS Organization** with all features enabled
- **IAM Identity Center** enabled in the management account
- **AWS credentials** with management account access

```bash
mkdir my-org && cd my-org
npm init -y && npm pkg set type=module
npm install @beesolve/aws-accounts typescript
git init && echo -e "node_modules/\n.remote-state-cache.json" > .gitignore

npx aws-accounts bootstrap --region us-east-1
npx aws-accounts init

# aws.config.ts is now your source of truth
npx aws-accounts plan
npx aws-accounts apply
```

> **Detailed walkthrough:** See [Getting Started Guide](./docs/getting-started.md) for step-by-step instructions.
>
> **Want to remove this tool?** See [Uninstalling](./docs/uninstall.md) — the tool deploys minimal infrastructure and is easy to clean up.

## How It Works

1. **Bootstrap** (one-time) — deploys S3 bucket, IAM role, and Lambda to your AWS account
2. **Init** (one-time) — scans your org, generates `aws.config.ts` (your source of truth)
3. **Edit** — modify `aws.config.ts` to model your desired org structure
4. **Sync** — `plan` shows what will change; `apply` executes it

Requires **Node.js 24+**.

## Commands

| Command | Description |
|---------|-------------|
| `bootstrap` | One-time setup: creates Organization (if needed), guides Identity Center enablement, deploys infrastructure |
| `init` | Scans live AWS state and generates `aws.config.ts` + `aws.config.types.ts` |
| `regenerate` | Refreshes `aws.config.types.ts` (picklists, autocomplete) from current config |
| `plan` | Computes diff between desired config and actual AWS state |
| `apply` | Executes planned operations via Lambda |
| `upgrade` | Updates the deployed Lambda function code |
| `scan` | Refreshes remote state in S3 (advanced/recovery use) |
| `drift` | Shows what changed in AWS since last scan |
| `validate` | Validates `aws.config.ts` locally without hitting AWS |
| `config reveal` | Copies default CloudFormation templates to your project for customization |
| `graveyard` | Lists accounts parked in the Graveyard OU |
| `profile` | Generates an AWS CLI SSO profile block from local state |

## Configuration

After `init`, your project contains:

- **`aws.config.ts`** — your desired state: OUs, accounts, users, groups, permission sets, assignments
- **`aws.config.types.ts`** — generated types and helpers for IDE autocomplete

### Permission Sets

```ts
permissionSets: [
  {
    name: "AdminAccess",
    description: "Full administrator access",
    sessionDuration: "PT8H",
    awsManagedPolicies: ["arn:aws:iam::aws:policy/AdministratorAccess"],
    customerManagedPolicies: [],
  },
],
```

### IAM Policy Helpers

`aws.config.types.ts` exports `iam` helpers with service-scoped action autocomplete:

```ts
import { awsConfigSchema, iam, type AwsConfig } from "./aws.config.types.js";

Action: [iam.s3("GetObject"), iam.identitystore("CreateGroupMembership")]
```

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
- Set permission set session duration (ISO-8601, e.g. `"PT8H"` — default 1h, max 12h)
- Manage inline policies, AWS managed policies, and customer-managed policy references
- Grant and revoke account assignments
- Reprovision changed permission sets

## Plan/Apply Safety

- `plan` fetches current remote state before computing the diff
- `apply` recomputes the plan before executing — no stale operations
- Destructive operations require `--allow-destructive`
- Human-readable previews mark destructive operations explicitly

### Recovery after failed apply

```bash
npx aws-accounts scan        # refresh state from live AWS
npx aws-accounts plan        # review remaining diff
npx aws-accounts apply       # re-apply
```

## CLI Options

```
npx aws-accounts <command> [options]

Options:
  --profile <name>          AWS profile (fallback: AWS_PROFILE)
  --region <region>         AWS region (fallback: AWS_REGION, AWS_DEFAULT_REGION)
  --yes                     Skip interactive confirmations
  --json                    Output plan as JSON (plan command)
  --allow-destructive       Allow destructive operations (apply command)
  --redeploy-stacksets      Force re-deployment of security baseline StackSets (apply command)
  --ignore-unsupported      Proceed with non-destructive unsupported diffs (apply command)
  --refresh                 Force state refresh before planning (plan command)
  --sso-start-url <url>     IAM Identity Center access portal URL (fallback: AWS_SSO_START_URL)
  --sso-session <name>      SSO session name for profile output (fallback: AWS_SSO_SESSION; default: sso)
  --help                    Show help
```

## IAM Permissions

The CLI delegates all AWS operations to a deployed Lambda. Day-to-day usage requires only:

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

`bootstrap` and `upgrade` require broader permissions (S3, IAM, Lambda, SSO).

Commands needing no AWS permissions: `regenerate`, `validate`, `graveyard`.

## SCP Patterns

The generated `aws.config.types.ts` exports reusable policy builders:

```ts
import { policies } from "./aws.config.types.js";

policies: {
  serviceControlPolicies: [
    policies.scp.blockExpensiveResources({
      allowedEc2InstanceTypes: ["t3.micro", "t3.small", "t4g.medium"],
      targets: ["root"],
    }),
  ],
}
```

See [Security Baseline](./docs/security-baseline.md) for CloudTrail, AWS Config, GuardDuty, and root access management.

## FAQ

### I moved an account manually in the AWS Console. How do I fix my config?

Run `npx aws-accounts init` (delete `aws.config.ts` first). This rewrites config from live AWS state.

### What happens if I run `scan` + `regenerate`?

`regenerate` refreshes only types, not config. Use `init` to reset config to live state.

### Multiple Identity Center instances?

The CLI will fail and require `--instance-arn`.

## License

[MIT](./LICENSE)
