# Security Baseline + StackSets — Task Checklist

Reference: `.kiro/plans/security-baseline-stacksets.md`

## Tasks

- [x] **Task 1: Rename `policies.ts` → `security.ts`, update exports**
  - Rename `src/policies.ts` → `src/security.ts`
  - Rename `src/policies.test.ts` → `src/security.test.ts`
  - Update `package.json` exports: add `"./security"`, keep `"./policies"` as alias
  - Update `src/awsConfig.ts` codegen import path (`@beesolve/aws-accounts/security`)
  - Update all internal references
  - Run typecheck + tests

- [x] **Task 2: Implement `withSecurityBaseline()` function**
  - Define `SecurityBaselineOptions<T, A>` type
  - Define `SecurityBaselineConfig` return type (extends `AwsConfig` with `securityBaseline` field)
  - Implement: adds `delegatedAdministrators` entries for enabled features
  - Implement: records StackSet metadata in `securityBaseline.stackSets`
  - Implement: validates referenced account names exist in config (runtime assertion)
  - Export from `@beesolve/aws-accounts/security`
  - Unit tests: config enhancement, validation errors, idempotency

- [x] **Task 3: Extend `AwsConfigModel` with optional `securityBaseline` field**
  - Add `securityBaseline` to `awsConfigModelSchema` (optional)
  - Add StackSet state to `stateSchema`
  - Update `mapAwsConfigToState` to serialize StackSet declarations
  - Update `mapStateToAwsConfig` to deserialize StackSet state
  - Update diff logic to detect StackSet changes
  - Tests for round-trip mapping

- [x] **Task 4: Create default CloudFormation templates**
  - Create `templates/config-recorder.yaml` with parameterized Config recorder
  - Create `templates/guardduty-member.yaml` with parameterized GuardDuty detector
  - Add `"templates"` to `files` in `package.json`
  - Implement template resolution helper (user `./templates/` > package default)
  - Unit test for resolution logic

- [x] **Task 5: Implement `config reveal` CLI command**
  - New file `src/commands/configReveal.ts`
  - Copies package templates to `./templates/` in user project
  - Skips files that already exist (no silent overwrite)
  - Register in CLI dispatcher (`src/cli.ts`)
  - Test: copies files, respects existing overrides

- [x] **Task 6: Add `getUploadUrl` Lambda action**
  - Add `getUploadUrl` request/response schemas to `lambdaClient.ts`
  - Implement handler in `src/lambda/handler.ts`: generates presigned PUT URL for given S3 key
  - CLI-side: upload template YAML to S3 via presigned URL
  - Test: presigned URL generation, upload flow

- [x] **Task 7: Add `deployStackSet` Lambda action**
  - Add `deployStackSet` request/response schemas
  - Implement handler: reads template from S3, calls CloudFormation StackSets API
  - Handle create vs update (idempotent)
  - Use service-managed permissions (Organizations integration)
  - Manage StackSet instances for target OUs
  - Test: create, update, idempotency

- [ ] **Task 8: Add StackSet operation types to plan/apply**
  - New operation kinds in `src/operations.ts`: `createStackSet`, `updateStackSet`, `deleteStackSet`
  - Diff logic in `src/diff.ts`: compare desired StackSets vs current state
  - Apply logic in `src/applyLogic.ts`: upload template → invoke `deployStackSet`
  - Display in plan output: `[stackset] create "Name" targeting X (regions)`
  - Tests for diff and apply

- [x] **Task 9: Extend Lambda IAM role permissions**
  - Update `src/commands/remote.ts` bootstrap to add CloudFormation StackSet permissions
  - Required actions: `cloudformation:CreateStackSet`, `CreateStackInstances`, `UpdateStackSet`, `UpdateStackInstances`, `DeleteStackSet`, `DeleteStackInstances`, `DescribeStackSet`, `DescribeStackSetOperation`, `ListStackSets`, `ListStackInstances`
  - Add Organizations trust for service-managed StackSets
  - Test: bootstrap creates role with correct permissions

- [x] **Task 10: Update README and docs**
  - Add "Security Baseline" section to README
  - Include ready-to-copy Security OU snippet
  - Document `withSecurityBaseline()` API and all options
  - Document `config reveal` command
  - Document template override mechanism
  - Document configurable StackSet parameters

- [ ] **Task 11: Integration tests**
  - `withSecurityBaseline` produces valid enhanced config
  - Plan shows StackSet operations for enabled features
  - Template resolution prefers user overrides
  - `validate` command catches missing account references in security baseline options
  - Round-trip: state → config → state preserves StackSet declarations

## Dependencies

```
Task 1 (rename) ─────────────────────────────────────┐
Task 2 (withSecurityBaseline) ──── depends on Task 1 │
Task 3 (schema extension) ──────── depends on Task 1 │
Task 4 (templates) ─────────────── no dependencies   │
Task 5 (config reveal) ─────────── depends on Task 4 │
Task 6 (getUploadUrl Lambda) ───── no dependencies   │
Task 7 (deployStackSet Lambda) ─── depends on Task 6 │
Task 8 (plan/apply) ────────────── depends on 2,3,7  │
Task 9 (IAM permissions) ──────── depends on Task 7  │
Task 10 (docs) ─────────────────── depends on all    │
Task 11 (integration tests) ────── depends on all    │
```

## Parallelization

Can run in parallel:
- Tasks 1, 4, 6 (no shared dependencies)
- Tasks 2, 3 (after Task 1)
- Tasks 5, 7 (after their deps)

Sequential:
- Task 8 requires 2, 3, 7 complete
- Tasks 9, 10, 11 are final
