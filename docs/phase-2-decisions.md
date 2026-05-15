# Phase 2 Decisions

> **Note:** The local execution model described in this document was removed in favor of remote-only execution. See [docs/adr/001-remove-local-execution-model.md](adr/001-remove-local-execution-model.md).

This file records agreed behaviour before implementing phase 2 (`bootstrap`): ensure **`Graveyard`** organizational unit exists and persist context locally.

## Lifecycle position

`bootstrap` is an init-time command. It is invoked by `init` (phase 3) for first-time setup and may be re-run independently to verify or repair OUs. It is idempotent — re-running it on an already-bootstrapped organization is safe. It is **not** part of the routine `plan` / `apply` loop in increment 1.

## Scope

- **OU-only**: `bootstrap` creates or discovers OUs only. It does **not** create or edit `aws.config.ts`, `state.json`, or deploy Lambda/S3.
- **Parent OU**: **`Graveyard`** is always created as a **direct child of the organization root** (no `--parent-ou-id`).
- **Name**: fixed **`Graveyard`** (exact name match). No configurable names in this phase.

## CLI contract

- Command: `bootstrap`
- Options (aligned with phase 1 credential resolution):
  - `--profile` (fallback: `AWS_PROFILE`)
  - `--region` (fallback: `AWS_REGION`, then `AWS_DEFAULT_REGION`)
  - `--instance-arn` (required only when multiple Identity Center instances exist)
  - `--yes` skip interactive confirmation (required in non-interactive environments when mutations would occur)

### Confirmation behaviour

- `bootstrap` command receives `planConfirmation: (props) => Promise<boolean>` through props.
- CLI owns TTY/`--yes` handling and passes callback behavior to command logic.

## Conflict handling (`aws.context.json`)

- **No merging** of ambiguous or partial updates.
- If **`aws.context.json` already exists**:
  - After resolving the authoritative picture from AWS (and after any creates requested in this run), compare persisted **`organization`** / **`identityCenter`** identifiers against what we resolved.
  - If any stored identifier **disagrees** with live resolution (for example stored `graveyardOuId` does not match the live OU named `Graveyard` under root), **fail** with a descriptive error. User must fix the file or AWS manually.

## AWS behaviour

### Reads

- Use Organizations APIs to resolve **root id**, **management account id**, and **child OUs of root** matching `Graveyard`.

### Writes

- Call **`CreateOrganizationalUnit`** only when a required OU name is missing under root.
- **Fail fast**: if create fails, **do not** re-list to reconcile races; surface the AWS error and exit non-zero.

### Pagination / retries

- Reuse the same inline pagination approach as phase 1 (`do { ... } while (NextToken != null)`).
- Retries are handled by the AWS SDK v3 default `StandardRetryStrategy` on read paths — no custom retry helper.
- Retries on failed **create** are **not** used to mask conflicts (still fail fast on hard errors). The SDK's default retry policy already excludes non-retryable client errors like duplicate-name conflicts.

## Identity Center metadata (required)

Bootstrap remains OU-first but **`aws.context.json` always requires `identityCenter`**.

- Call **`sso:ListInstances`**:
  - **Exactly one** instance: persist `instanceArn` and `identityStoreId`.
  - **Zero** instances: fail bootstrap.
  - **Multiple** instances: require `--instance-arn` and fail when omitted.

## `aws.context.json` shape (phase 2 target)

Single file at repository root. **camelCase** keys. Unknown keys on read are rejected (same strict policy as `state.json`).

Proposed minimal schema for phase 2:

```json
{
  "version": "1",
  "generatedAt": "2026-05-06T00:00:00.000Z",
  "organization": {
    "managementAccountId": "string",
    "rootId": "string",
    "graveyardOuId": "string"
  },
  "identityCenter": {
    "instanceArn": "string",
    "identityStoreId": "string"
  },
  "deployment": {
    "profile": "string-or-empty",
    "region": "string-or-empty",
    "lambdaArn": "",
    "stateBucketName": ""
  }
}
```

- **`deployment.lambdaArn`** / **`deployment.stateBucketName`**: leave empty until later increments.
- **`deployment.profile`** / **`deployment.region`**: record what was used for the call (resolved values) for reproducibility.

## Safety

- No deletes, no account moves, no IAM Identity Center mutations in phase 2.
- Log intended creates explicitly (parent root id, OU name).

## Tests

- Colocate unit tests next to the command implementation: **`src/commands/bootstrap.test.ts`** (pure logic: given listed root child OUs, decide creates vs reuse; conflict detection helpers).

## IAM

- Inline policy for `bootstrap` is documented in **`README.md`** (`organizations:CreateOrganizationalUnit` + read helpers).
