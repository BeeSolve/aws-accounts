# @beesolve/aws-accounts

[![npm version](https://img.shields.io/npm/v/@beesolve/aws-accounts)](https://www.npmjs.com/package/@beesolve/aws-accounts)
[![license](https://img.shields.io/npm/l/@beesolve/aws-accounts)](./LICENSE)

Config-driven management for AWS Organizations and IAM Identity Center. Define your org structure, accounts, permission sets, and access assignments in a single TypeScript file — then `plan` and `apply` changes like Terraform.

## Installation

```bash
npm install @beesolve/aws-accounts
```

## Prerequisites

- **Node.js 24+**
- **AWS Organization** with all features enabled
- **IAM Identity Center** enabled in the organization's management account (or delegated admin account)
- **AWS credentials** with access to the management account (via environment, profile, or SSO)

## Quick Start

```bash
# 1. Create a project directory
mkdir my-org && cd my-org
npm init -y
npm pkg set type=module
npm install @beesolve/aws-accounts typescript

# 2. Initialize git and add a .gitignore
git init
echo -e "node_modules/\n.remote-state-cache.json" > .gitignore

# 3. Deploy remote infrastructure (S3 bucket, IAM role, Lambda)
npx aws-accounts bootstrap --region us-east-1

# 4. Scan your AWS org and generate aws.config.ts
npx aws-accounts init

# 5. Edit aws.config.ts to model your desired state

# 6. Preview and apply changes
npx aws-accounts plan
npx aws-accounts apply
```

After `init`, `aws.config.ts` is your source of truth. Edit it to add accounts, move OUs, manage permission sets, and control access — then sync with `plan` / `apply`.

> **`.gitignore` recommendation:** Add `node_modules/` and `.remote-state-cache.json` to your `.gitignore`. The cache file is a local copy of remote state that varies per environment and should not be committed.

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
| `validate` | Validates `aws.config.ts` locally without hitting AWS |
| `config reveal` | Copies default CloudFormation templates to your project for customization |
| `graveyard` | Lists accounts parked in the Graveyard OU |
| `profile` | Generates an AWS CLI SSO profile block from local state |

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

### Permission Sets

```ts
permissionSets: [
  {
    name: "AdminAccess",
    description: "Full administrator access",
    sessionDuration: "PT8H", // ISO-8601 duration; omit to use the AWS default of 1h (max 12h)
    awsManagedPolicies: ["arn:aws:iam::aws:policy/AdministratorAccess"],
    customerManagedPolicies: [],
  },
],
```

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
- Set permission set session duration (ISO-8601, e.g. `"PT8H"` — default 1h, max 12h)
- Manage inline policies, AWS managed policies, and customer-managed policy references
- Grant and revoke account assignments
- Reprovision changed permission sets

## Validating your config

Run `validate` before `plan` to catch mistakes locally without making any AWS API calls:

```bash
npx aws-accounts validate
```

It checks two layers:

**Schema and reference errors** — caught by compiling `aws.config.ts` against the generated types in `aws.config.types.ts`:
- Type mismatches and missing required fields
- References to unknown OUs, accounts, groups, users, or permission sets (enforced by the generated picklist types)

**Semantic errors** — additional checks run after the schema passes:
- Circular OU parent references (e.g. OU A has `parentName: "B"` and B has `parentName: "A"`)
- Assignments with no principal or with both `group` and `user` set
- Permission set inline policies exceeding the 10,240 character limit

Exits with code 1 if any errors are found, making it safe to use in CI before running `plan`.

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

## Generating AWS CLI profiles

The `profile` command reads your local state cache and presents an interactive picker of every account/permission-set combination you have access to, then prints a ready-to-paste `~/.aws/config` block:

```bash
npx aws-accounts profile --sso-start-url https://d-xxxxxxxxxx.awsapps.com/start
```

```ini
[profile my-account-admin-access]
sso_session = sso
sso_account_id = 123456789012
sso_role_name = AdminAccess

[sso-session sso]
sso_start_url = https://d-xxxxxxxxxx.awsapps.com/start
sso_region = eu-central-1
sso_registration_scopes = sso:account:access
```

The SSO start URL is not returned by the AWS API — set it via the flag or the `AWS_SSO_START_URL` environment variable to avoid typing it every time. Use `--sso-session <name>` or the `AWS_SSO_SESSION` environment variable to customise the session name (default: `sso`).

Requires a populated local state cache — run `plan` or `scan` first if the cache is empty.

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

Commands that need no AWS permissions: `regenerate` (local codegen only), `validate` (local config checks only), `graveyard` (reads local cache only).

## SCP Patterns

The generated `aws.config.types.ts` exports a `policies` object with reusable builders for SCPs, backup policies, and permission sets:

```ts
import { policies } from "./aws.config.types.js";
```

### `policies.scp.blockExpensiveResources(options)`

Generates a deny-by-default SCP that blocks expensive resource creation — designed to protect against account compromise (cryptomining, LLM API abuse).

**What it blocks:**

- All Amazon Bedrock actions (`bedrock:*`)
- All EC2 instance types **except** those you explicitly allow
- Expensive compute services: SageMaker, ECS, EKS nodegroups, Lightsail, App Runner
- Expensive purchases: reserved instances, savings plans, Marketplace subscriptions, vault locks, Shield, domain registration, Snowball, and more

**Options:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `allowedEc2InstanceTypes` | `string[]` | *required* | EC2 instance types to allow (everything else is denied) |
| `exemptAccounts` | `string[]` | `[]` | Account IDs exempt from all restrictions |
| `targets` | `string[]` | `["root"]` | OU/account names to attach the SCP to |
| `name` | `string` | `"BlockExpensiveResources"` | Policy name |

**Example:**

```ts
policies: {
  serviceControlPolicies: [
    policies.scp.blockExpensiveResources({
      exemptAccounts: [],
      allowedEc2InstanceTypes: [
        "t3.nano", "t3.micro", "t3.small", "t3.medium",
        "t4g.nano", "t4g.micro", "t4g.small", "t4g.medium",
        "m8g.medium", "m8g.large",
      ],
      targets: ["root"],
    }),
  ],
}
```

To grant GPU/Bedrock access to a specific account, add its account ID to `exemptAccounts`:

```ts
policies.scp.blockExpensiveResources({
  exemptAccounts: ["123456789012"],
  allowedEc2InstanceTypes: ["t3.micro", "t3.small", "t4g.medium", "m8g.medium"],
})
```

## Security Baseline

The `withSecurityBaseline()` wrapper enables AWS security best practices — CloudTrail, AWS Config, GuardDuty, and root access management — through a single config enhancement. All features are independently opt-in.

```ts
import { withSecurityBaseline } from "./aws.config.types.js";

const awsConfig = withSecurityBaseline(
  {
    organizationalUnits: [/* your config */],
    delegatedAdministrators: [],
    // ... rest of standard config
  },
  {
    cloudTrail: {
      enabled: true,
      delegatedAdminAccount: "SecurityAudit",
      logArchiveAccount: "LogArchive",
      organizationTrail: true,
    },
    configRecorder: {
      enabled: true,
      delegatedAdminAccount: "SecurityAudit",
      deliveryBucketAccount: "LogArchive",
      targets: ["root"],
    },
    guardDuty: {
      enabled: true,
      delegatedAdminAccount: "SecurityAudit",
    },
  },
);

export default awsConfig;
```

For the full guide — feature details, cost estimates, viewing security data, permission set helpers, SCP protection, template overrides, and manual cleanup — see **[docs/security-baseline.md](./docs/security-baseline.md)**.

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
