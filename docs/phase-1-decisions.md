# Phase 1 Decisions

This file records decisions made before and during implementation of phase 1 (scan).

## Lifecycle position

`scan` is an init-time command. It is invoked by `init` (phase 3) for first-time setup and may be re-run independently for debugging or drift inspection. It is **not** part of the routine `plan` / `apply` loop in increment 1 — state updates after `apply` come from the planned-next-state, not a fresh scan.

## CLI contract

- Command: `scan`
- Supported options:
  - `--profile` (fallback: `AWS_PROFILE`)
  - `--region` (fallback: `AWS_REGION`, then `AWS_DEFAULT_REGION`)
  - `--instance-arn` for explicit IAM Identity Center instance selection
- No `--output` option in increment 1. Output path is fixed to repository root `state.json`.

## Identity Center instance selection

- If no IAM Identity Center instances exist, fail.
- If exactly one instance exists, use it automatically.
- If multiple instances exist, fail and require `--instance-arn`.

## Data model and state storage

- `state.json` uses a flat organization model with parent references:
  - OUs are stored as a flat list with `parentId`.
  - Accounts include `parentId` for OU/root placement.
- Identity Center data includes:
  - users
  - groups
  - permission sets
  - account assignments
  - `accessRoles` (derived role metadata from assignments)

## Sorting and determinism

- Normalization sorts entities by stable identifiers first (`id`/`arn`), then display fields (`name`/`displayName`).
- `state.json` is written in deterministic order for stable diffs.

## Validation approach

- Unknown fields are rejected.
- Validation is kept close to implementation in `src/state.ts` (no global schema folder).

## Error handling and scan strictness

- Strict mode for scanning: if any required scan section fails, entire scan fails.
- Read-only AWS access in phase 1 scan.
- Pagination is implemented inline with `do { ... } while (NextToken != null)` per listing call.

## Retry strategy

- No custom retry helper. The AWS SDK v3 clients (`@aws-sdk/client-organizations`, `@aws-sdk/client-sso-admin`, `@aws-sdk/client-identitystore`) ship with `StandardRetryStrategy` enabled by default — exponential backoff on throttling and transient transport errors. Wrapping `.send()` calls in a custom retry helper would double-retry without adding value.
- If a future failure mode requires a different retry policy (longer backoff, jitter tuning), configure it via the SDK's `retryStrategy` client option rather than a separate helper module.
