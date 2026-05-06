# Increment 1 Plan (Local-Only)

Scope for this increment:
- Run locally via `npm run cli`.
- No Lambda deployment/invocation.
- No S3 usage.
- No destructive operations (assume administrator privileges, but avoid any action that mutates existing AWS resources unexpectedly).
- Build foundations so cloud-backed flow can be layered in later increments.
- Repository-root files for increment 1: `state.json`, `aws.config.ts`, `aws.context.json`.

## Phase 1: Implement scanning (local execution)

- [ ] Define local scan command contract (`scan`) and CLI arguments/env handling (`profile`, `region`).
- [ ] Define canonical local state shape (`state.json`) for OUs, accounts, IAM Identity Center users/groups/permission sets/assignments.
- [ ] Implement AWS SDK v3 read-only clients setup (Organizations + Identity Center related APIs).
- [ ] Implement scanner module to fetch:
  - [ ] OU tree
  - [ ] accounts and OU placement
  - [ ] identity center users/groups
  - [ ] permission sets and account assignments
- [ ] Implement pagination/retry/error handling for scanner calls.
- [ ] Persist scan output locally to `state.json` (workspace path), with deterministic ordering for stable diffs.
- [ ] Add validation of produced state with valibot schemas.
- [ ] Add node test runner coverage for scanner normalization and schema validation.
- [ ] Add CLI output summarizing discovered resources and output file path.

## Phase 2: Bootstrap OUs (Pending, Graveyard) locally-first flow

- [ ] Define bootstrap command contract (`bootstrap`) for local-first mode (no Lambda/S3 setup in increment 1).
- [ ] Define idempotent logic to ensure required OUs exist: `Pending`, `Graveyard`.
- [ ] Implement read-before-write checks to avoid duplicate OU creation.
- [ ] Implement OU creation in AWS Organizations for missing required OUs (`Pending`, `Graveyard`).
- [ ] Implement safe guards:
  - [ ] no deletion
  - [ ] no re-parenting except explicitly required by command scope
  - [ ] clear prompt/log before any create operation
- [ ] Persist discovered/created OU IDs into local context file (`aws.context.json`).
- [ ] Ensure generated/updated context structure is future-compatible with later Lambda/S3 fields.
- [ ] Add tests for bootstrap decision logic (exists vs create).
- [ ] Add CLI summary showing OU actions planned/executed.

## Phase 3: Implement `state.json` -> `aws.config.ts` + `aws.context.json`

- [ ] Define internal domain model that maps raw scanned state to config representation.
- [ ] Define deterministic codegen format for `aws.config.ts` (stable key ordering, readable structure).
- [ ] Implement transform pipeline:
  - [ ] load `state.json`
  - [ ] validate with valibot
  - [ ] map to domain model
  - [ ] emit `aws.config.ts`
- [ ] Implement context synchronization rules for `aws.context.json` (org root, required OU ids, metadata).
- [ ] Add non-destructive file write behavior (preview/diff mode before overwrite).
- [ ] Add tests for transform correctness and stable code generation snapshots.
- [ ] Add CLI command/output for regeneration and status.

## Phase 4: Implement account creation (local CLI direct AWS calls)

- [ ] Define create-account command contract (`create-account --email --name`).
- [ ] Implement input validation via valibot (email format, account name constraints).
- [ ] Resolve `Pending` OU ID from `aws.context.json` (or fail with actionable error).
- [ ] Implement direct AWS Organizations create account flow (local CLI call in increment 1).
- [ ] Implement polling until account status is terminal; surface progress to user.
- [ ] Enforce create-account polling timeout at 15 minutes with clear timeout error.
- [ ] On success, update local `aws.config.ts` with newly created account in `Pending`.
- [ ] Ensure operation is idempotent-safe for retries (detect already-created account by email/name where possible).
- [ ] Add tests for command validation and config update logic.
- [ ] Add clear terminal feedback: started, waiting, created, config updated.

## Phase 5: Implement add/modify flow (config-driven reconciliation)

- [ ] Define reconciliation command pair for local mode:
  - [ ] `plan` (diff local desired `aws.config.ts` vs local current `state.json`)
  - [ ] `apply` (execute approved operations directly via AWS SDK in CLI for increment 1)
- [ ] Define operation model for supported mutations in increment 1:
  - [ ] move account between OUs
  - [ ] add account metadata entries
- [ ] Exclude IAM Identity Center assignment mutations from increment 1 apply scope.
- [ ] Implement diff engine producing human-readable and machine-readable plan.
- [ ] Implement safety policy:
  - [ ] default no destructive actions
  - [ ] explicit guardrails for unsupported/destructive diffs
  - [ ] require confirmation before apply (interactive prompt)
  - [ ] support non-interactive approval via `--yes`
- [ ] Implement apply executor with per-operation progress + final outcome summary.
- [ ] After apply, refresh local `state.json` (re-scan) and regenerate `aws.config.ts` if needed.
- [ ] Add tests for plan generation and apply sequencing.

## Cross-cutting implementation checklist

- [ ] Keep CLI logic in one primary file (helpers extracted only when reused).
- [ ] Keep Lambda handler code in one file (placeholder only in increment 1 if not used yet).
- [ ] Use esbuild for build outputs and local run wiring.
- [ ] Use TypeScript 6+ conventions and camelCase naming.
- [ ] Avoid barrel files.
- [ ] Add consistent error model and exit codes for CLI commands.
- [ ] Add README usage notes for local increment commands and safety constraints.
