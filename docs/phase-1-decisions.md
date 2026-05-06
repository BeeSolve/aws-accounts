# Phase 1 Decisions

This file records decisions made before and during implementation of phase 1 (scan).

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
- Pagination and retry logic included for transient AWS failures.
