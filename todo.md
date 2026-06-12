# Todo

## Done (can be removed)

- [x] Lambda function memory and timeout configurable through `aws.context.json` — defaults are 1024MiB and 5m, written to deployment config on bootstrap. See `deploymentSchema` fields `lambdaMemoryMb`, `lambdaTimeoutSeconds`.

## In Progress (has plan)

- [ ] Root access management + password policy — see `.kiro/plans/root-access-password-policy.md`
  - Enable centralized root credentials management (disable root for member accounts)
  - Deploy IAM password policy to all accounts via Lambda assume-role
  - `scp.denyRootWithoutMfa()` already implemented
  - `withSecurityBaseline({ rootAccessManagement: { enabled: true } })` registers delegated admin

## Backlog

- [ ] Replace manual credential validation with Valibot schema parsing (handler.ts:527):
  ```ts
  // Before:
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
    throw new Error(`Failed to assume role in account ${props.targetAccountId}`);
  }
  // After: v.parse(assumedCredentialsSchema, assumeResult.Credentials)
  ```
- [ ] Support settings for creating IAM Identity Center instance (currently requires pre-existing instance; tool could optionally create one during bootstrap)
- [ ] Split `remote.ts` into subcommand files (76KB) — see `.kiro/plans/code-review-findings.md`
- [ ] Unify Lambda request/response schemas in shared module
- [ ] Add Biome config and lint step to CI
- [ ] Add exponential backoff for transient AWS errors
- [ ] `destroy` command — see `.kiro/plans/resource-cleanup-destroy.md`
- [ ] Integration tests for security baseline — Task 11 in `.kiro/plans/security-baseline-checklist.md`
