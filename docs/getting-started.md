# Getting Started

This guide covers two paths to getting started with `@beesolve/aws-accounts`.

## Path A: Starting from Scratch (New AWS Account)

If you don't have an AWS account yet:

1. **Create an AWS account** at https://portal.aws.amazon.com/billing/signup
2. **Set up credentials** — create an IAM user with admin access or configure SSO. See [AWS docs on configuring credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html).

Once you have an account with credentials configured:

### 1. Create your project

```bash
mkdir my-org && cd my-org
npm init -y
npm pkg set type=module
npm install @beesolve/aws-accounts typescript
```

### 2. Initialize git

```bash
git init
echo -e "node_modules/\n.remote-state-cache.json" > .gitignore
```

### 3. Bootstrap

```bash
npx aws-accounts bootstrap --region eu-central-1
```

The CLI will guide you through:

- **Organization creation** — detects no Organization exists and offers to create one with all features enabled. If you already have an Organization with only consolidated billing, it will tell you how to enable all features.
- **Identity Center setup** — detects Identity Center is not enabled and provides:
  - A direct Console URL for your region
  - Step-by-step instructions to click "Enable"
  - Guidance to keep the default "Identity Center directory" identity source
  - A polling loop that waits for you to complete the Console action
- **Infrastructure deployment** — creates the S3 state bucket, IAM role, and Lambda function

### 4. Scan and generate config

```bash
npx aws-accounts init
```

This scans your (currently empty) org and generates:
- `aws.config.ts` — your editable source of truth
- `aws.config.types.ts` — generated types for IDE autocomplete

### 5. Define your desired state

Edit `aws.config.ts` to add organizational units, accounts, users, groups, and permission sets. Example:

```ts
import { awsConfigSchema, iam, type AwsConfig } from "./aws.config.types.js";

const awsConfig: AwsConfig = {
  organizationalUnits: [
    { name: "Production", parentName: "root" },
    { name: "Development", parentName: "root" },
  ],
  accounts: [
    { name: "prod-app", email: "aws+prod@example.com", parentName: "Production" },
    { name: "dev-app", email: "aws+dev@example.com", parentName: "Development" },
  ],
  users: [
    { userName: "admin", displayName: "Admin User", email: "admin@example.com" },
  ],
  groups: [
    { displayName: "Admins", description: "Full access", members: ["admin"] },
  ],
  permissionSets: [
    {
      name: "AdminAccess",
      description: "Full administrator access",
      sessionDuration: "PT8H",
      awsManagedPolicies: ["arn:aws:iam::aws:policy/AdministratorAccess"],
      customerManagedPolicies: [],
    },
  ],
  accountAssignments: [
    { target: "prod-app", permissionSet: "AdminAccess", group: "Admins" },
    { target: "dev-app", permissionSet: "AdminAccess", group: "Admins" },
  ],
};

export default awsConfig;
```

### 6. Preview and apply

```bash
npx aws-accounts plan      # see what will change
npx aws-accounts apply     # execute the changes
```

---

## Path B: Existing Organization

If you already have an AWS Organization with Identity Center enabled:

### Prerequisites

- AWS Organization with **all features** enabled
- IAM Identity Center enabled (any region)
- AWS credentials with access to the **management account**
- Node.js 24+

### 1. Create your project

```bash
mkdir my-org && cd my-org
npm init -y
npm pkg set type=module
npm install @beesolve/aws-accounts typescript
git init
echo -e "node_modules/\n.remote-state-cache.json" > .gitignore
```

### 2. Bootstrap

```bash
npx aws-accounts bootstrap --region us-east-1
```

This deploys the remote infrastructure (S3 bucket, IAM role, Lambda). It detects your existing Organization and Identity Center and skips the setup prompts.

### 3. Import your existing state

```bash
npx aws-accounts init
```

This scans your entire org — OUs, accounts, users, groups, permission sets, assignments, policies — and generates `aws.config.ts` reflecting your current state.

### 4. Make changes

Edit `aws.config.ts` to add, modify, or remove resources. Run `regenerate` after editing to refresh IDE autocomplete:

```bash
npx aws-accounts regenerate
```

### 5. Preview and apply

```bash
npx aws-accounts plan
npx aws-accounts apply
```

---

## Day-to-Day Workflow

Once set up, the workflow is:

1. Edit `aws.config.ts`
2. Run `validate` to catch mistakes locally
3. Run `plan` to preview changes
4. Run `apply` to execute
5. Commit your changes to git

### Useful commands

- `npx aws-accounts drift` — check if someone made changes in the Console
- `npx aws-accounts profile --sso-start-url <url>` — generate AWS CLI SSO profiles
- `npx aws-accounts validate` — local config validation (safe for CI)

---

## Troubleshooting

### "account concurrency quota too low"

New AWS accounts start with a Lambda concurrency quota of 10. The tool tries to reserve 1 concurrent execution for safety but this fails on fresh accounts. This is non-blocking — the tool works fine without it. AWS auto-raises the quota over time, or you can request an increase at:

https://console.aws.amazon.com/servicequotas/home/services/lambda/quotas/L-B99A9384

Run `upgrade` afterward to apply the reservation.

### "all features" not enabled

If your org only has consolidated billing, enable all features:
https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_org_support-all-features.html

### Identity Center in a different region

Identity Center is region-specific. Use `--region` to match the region where you enabled it.
