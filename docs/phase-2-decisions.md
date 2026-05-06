# Phase 2 Decisions

This file records agreed behaviour before implementing phase 2 (`bootstrap`): ensure **`Pending`** and **`Graveyard`** organizational units exist and persist context locally.

## Scope

- **OU-only**: `bootstrap` creates or discovers OUs only. It does **not** create or edit `aws.config.ts`, `state.json`, or deploy Lambda/S3.
- **Parent OU**: **`Pending`** and **`Graveyard`** are always created as **direct children of the organization root** (no `--parent-ou-id`).
- **Names**: fixed **`Pending`** and **`Graveyard`** (exact name match). No configurable names in this phase.

## CLI contract

- Command: `bootstrap`
- Options (aligned with phase 1 credential resolution):
  - `--profile` (fallback: `AWS_PROFILE`)
  - `--region` (fallback: `AWS_REGION`, then `AWS_DEFAULT_REGION`)
  - `--instance-arn` (optional; see Identity Center below)
  - `--yes` skip interactive confirmation (required in non-interactive environments when mutations would occur)

### Confirmation behaviour

- **Interactive** (stdin is a TTY): print planned actions, then prompt before any `CreateOrganizationalUnit`.
- **Non-interactive** (no TTY): if creates would run, **require `--yes`**; otherwise exit with a clear error (CI-safe).

## Conflict handling (`aws.context.json`)

- **No merging** of ambiguous or partial updates.
- If **`aws.context.json` already exists**:
  - After resolving the authoritative picture from AWS (and after any creates requested in this run), compare persisted **`organization`** / **`identityCenter`** identifiers against what we resolved.
  - If any stored identifier **disagrees** with live resolution (for example stored `pendingOuId` does not match the live OU named `Pending` under root), **fail** with a descriptive error. User must fix the file or AWS manually.

## AWS behaviour

### Reads

- Use Organizations APIs to resolve **root id**, **management account id**, and **child OUs of root** matching `Pending` / `Graveyard`.

### Writes

- Call **`CreateOrganizationalUnit`** only when a required OU name is missing under root.
- **Fail fast**: if create fails, **do not** re-list to reconcile races; surface the AWS error and exit non-zero.

### Pagination / retries

- Reuse the same **pagination + limited retry** approach as phase 1 for throttling/transient errors on **read** paths.
- Retries on failed **create** are **not** used to mask conflicts (still fail fast on hard errors).

## Identity Center metadata (optional enrichment)

Bootstrap remains OU-first; still **`aws.context.json`** should carry fields useful for later phases.

- Call **`sso:ListInstances`** (same semantics as phase 1 for instance selection):
  - **Exactly one** instance: persist `instanceArn` and `identityStoreId` under **`identityCenter`** in context.
  - **Zero** instances: omit **`identityCenter`** or set nullable fields; OU bootstrap still succeeds.
  - **Multiple** instances: if **`--instance-arn`** is provided, persist that instance’s ARN + store id; otherwise **omit** Identity Center fields and **warn** (do not fail OU bootstrap). Users can re-run with `--instance-arn` or rely on `scan` later.

## `aws.context.json` shape (phase 2 target)

Single file at repository root. **camelCase** keys. Unknown keys on read are rejected when we add validation (same strict policy as `state.json`).

Proposed minimal schema for phase 2:

```json
{
  "version": "1",
  "generatedAt": "2026-05-06T00:00:00.000Z",
  "organization": {
    "managementAccountId": "string",
    "rootId": "string",
    "pendingOuId": "string",
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
