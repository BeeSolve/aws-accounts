# How to: Get Started with the aws-accounts CLI

> Full walkthrough: https://github.com/BeeSolve/aws-accounts/tree/main#getting-started

Manage an AWS Organization and IAM Identity Center from a typed `aws.config.ts` file. You edit the config, `plan` shows the diff against live AWS state, and `apply` executes it.

## Prerequisites

- Node.js 24+
- AWS credentials with management-account access
- For an existing org: AWS Organizations with all features enabled and IAM Identity Center enabled

## Steps

### 1. Create a project and install

```sh
mkdir my-org && cd my-org
npm init -y && npm pkg set type=module
npm install @beesolve/aws-accounts typescript
git init && echo -e "node_modules/\n.remote-state-cache.json" > .gitignore
```

### 2. Bootstrap (one-time)

Creates the Organization if none exists, guides you through enabling Identity Center, and deploys the remote infrastructure (S3 bucket, IAM role, Lambda).

```sh
npx aws-accounts bootstrap --region us-east-1
```

### 3. Init

Scans live AWS state and generates `aws.config.ts` (your source of truth) plus `aws.config.types.ts` (types and autocomplete helpers).

```sh
npx aws-accounts init
```

### 4. Edit `aws.config.ts`

Model your desired org: OUs, accounts, users, groups, permission sets, and assignments. After editing structure that affects picklists, refresh the generated types:

```sh
npx aws-accounts regenerate
```

Validate locally without hitting AWS:

```sh
npx aws-accounts validate
```

### 5. Plan and apply

`plan` computes the diff between your config and actual AWS state; `apply` executes the planned operations via the deployed Lambda.

```sh
npx aws-accounts plan
npx aws-accounts apply
```

## Common Pitfalls

- `apply` refuses to run non-interactively without `--yes`; pass it in CI.
- If you moved an account manually in the Console, run `scan` then `drift` to reconcile before planning.
- Destructive operations require `--allow-destructive` on `apply`.

## See Also

- [SCP Collection](./scp-collection.md) - compose Service Control Policies in your config
- [Full command reference](https://github.com/BeeSolve/aws-accounts/tree/main#commands)
