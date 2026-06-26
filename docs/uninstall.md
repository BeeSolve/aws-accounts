# Uninstalling

This tool deploys minimal infrastructure to your AWS account. Here's exactly what it creates and how to remove it.

## What the tool deploys

`bootstrap` creates three resources in your AWS account:

| Resource        | Name                                               | Purpose                                 |
| --------------- | -------------------------------------------------- | --------------------------------------- |
| S3 bucket       | `beesolve-aws-accounts-state-{accountId}-{region}` | Stores org state snapshots              |
| IAM role        | `beesolve-aws-accounts-lambda-role`                | Execution role for the Lambda           |
| Lambda function | `beesolve-aws-accounts`                            | Executes scan/apply operations remotely |

Optionally (if log group was created):
| Resource | Name | Purpose |
|----------|------|--------|
| CloudWatch Log Group | `/aws/lambda/beesolve-aws-accounts` | Lambda execution logs |

## What the tool does NOT create

The tool manages your Organization, Identity Center users/groups, permission sets, and account assignments — but these are **your resources**. Removing the tool does not remove your org structure, accounts, or access configuration. Those continue to work as-is.

## Removal steps

### 1. Delete the Lambda function

```bash
aws lambda delete-function --function-name beesolve-aws-accounts --region <region>
```

### 2. Delete the IAM role

```bash
# Remove inline policy first
aws iam delete-role-policy --role-name beesolve-aws-accounts-lambda-role --policy-name lambda-execution

# Delete the role
aws iam delete-role --role-name beesolve-aws-accounts-lambda-role
```

### 3. Delete the S3 bucket

```bash
# Empty the bucket first
aws s3 rm s3://beesolve-aws-accounts-state-<accountId>-<region> --recursive

# Delete the bucket
aws s3 rb s3://beesolve-aws-accounts-state-<accountId>-<region>
```

### 4. (Optional) Delete the CloudWatch log group

```bash
aws logs delete-log-group --log-group-name /aws/lambda/beesolve-aws-accounts --region <region>
```

### 5. Remove local files

Delete or keep your project directory as you prefer. The key files are:

- `aws.config.ts` — your org configuration (useful as documentation even without the tool)
- `aws.context.json` — deployment metadata
- `.remote-state-cache.json` — local cache of remote state

### 6. Uninstall the npm package

```bash
npm uninstall @beesolve/aws-accounts
```

## After removal

Your AWS Organization, accounts, Identity Center users, groups, permission sets, and access assignments remain exactly as they are. The tool only provides a management interface — removing it doesn't affect the managed resources.

You can re-install and `bootstrap` + `init` at any time to pick up where you left off.

## One-liner removal (all resources)

```bash
REGION=us-east-1
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

aws lambda delete-function --function-name beesolve-aws-accounts --region $REGION
aws iam delete-role-policy --role-name beesolve-aws-accounts-lambda-role --policy-name lambda-execution
aws iam delete-role --role-name beesolve-aws-accounts-lambda-role
aws s3 rm s3://beesolve-aws-accounts-state-$ACCOUNT_ID-$REGION --recursive
aws s3 rb s3://beesolve-aws-accounts-state-$ACCOUNT_ID-$REGION
aws logs delete-log-group --log-group-name /aws/lambda/beesolve-aws-accounts --region $REGION 2>/dev/null
```
