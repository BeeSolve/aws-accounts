# Increment 1 Plan (Local-Only)

Scope for this increment:
- Run locally via `npm run cli`.
- No Lambda deployment/invocation.
- No S3 usage.
- No destructive operations (assume administrator privileges, but avoid any action that mutates existing AWS resources unexpectedly).
- Build foundations so cloud-backed flow can be layered in later increments.
- Repository-root files for increment 1: `state.json`, `aws.config.ts`, `aws.context.json`.

## Phase 1: Implement scanning (local execution)

- [x] Define local scan command contract (`scan`) and CLI arguments/env handling (`profile`, `region`).
- [x] Define canonical local state shape (`state.json`) for OUs, accounts, IAM Identity Center users/groups/permission sets/assignments.
- [x] Implement AWS SDK v3 read-only clients setup (Organizations + Identity Center related APIs).
- [x] Implement scanner module to fetch:
  - [x] OU tree
  - [x] accounts and OU placement
  - [x] identity center users/groups
  - [x] permission sets and account assignments
- [x] Implement pagination/retry/error handling for scanner calls. (Pagination inline; retries delegated to AWS SDK v3 default `StandardRetryStrategy` — see `docs/phase-1-decisions.md`.)
- [x] Persist scan output locally to `state.json` (workspace path), with deterministic ordering for stable diffs.
- [x] Add validation of produced state with valibot schemas.
- [x] Add node test runner coverage for scanner normalization and schema validation.
- [x] Add node test runner coverage for `runScanCommand` via mocked AWS SDK clients.
- [x] Add CLI output summarizing discovered resources and output file path.

## Phase 2: Bootstrap OUs (Pending, Graveyard) locally-first flow

- [x] Define bootstrap command contract (`bootstrap`) for local-first mode (no Lambda/S3 setup in increment 1).
- [x] Define idempotent logic to ensure required OUs exist: `Pending`, `Graveyard`.
- [x] Implement read-before-write checks to avoid duplicate OU creation.
- [x] Implement OU creation in AWS Organizations for missing required OUs (`Pending`, `Graveyard`).
- [x] Implement safe guards:
  - [x] no deletion
  - [x] no re-parenting except explicitly required by command scope
  - [x] clear prompt/log before any create operation
- [x] Persist discovered/created OU IDs into local context file (`aws.context.json`).
- [x] Ensure generated/updated context structure is future-compatible with later Lambda/S3 fields.
- [ ] Add tests for bootstrap decision logic (exists vs create).
- [x] Add CLI summary showing OU actions planned/executed.

## Phase 3: First-time `init` and config-driven type regeneration

- [ ] Define `init` CLI command contract that orchestrates `bootstrap` + `scan` + state→config write. Supports `--profile`, `--region`, `--instance-arn`, `--yes`.
- [ ] Define `regenerate` CLI command contract that refreshes `aws.config.types.ts` from the current `aws.config.ts`. Supports `--yes`.
- [ ] Define internal domain model that maps raw scanned state to config representation:
  - [ ] single `organizationalUnits` list with synthetic `{ name: "root", parentName: null }` entry holding accounts that live directly under the organization root.
  - [ ] account references as `{ name, email }`; cross-references by name throughout (no AWS-issued ids/arns in `aws.config.ts`).
  - [ ] assignments grouped by `(principal, permissionSet)` with `accounts: string[]`.
  - [ ] exclude `accessRoles` (derivable from `permissionSet` + `accountId`).
- [ ] Define generated `aws.config.types.ts` exporting both the valibot schema (`awsConfigSchema`) and the inferred `AwsConfig` type:
  - [ ] picklists for cross-references: OU names (used in `parentName`), account names, permission set names, group display names, user user names.
  - [ ] entity `name` fields (where the name is *defined*, not referenced) stay plain `v.string()`.
  - [ ] `parentName` typed as `v.union([organizationalUnitNameSchema, v.null_()])`.
- [ ] Define deterministic codegen format for `aws.config.ts` (stable key ordering, readable structure).
- [ ] Implement state → config transform (`mapStateToAwsConfig`):
  - [ ] load and validate `state.json`.
  - [ ] cross-validate against `aws.context.json` (rootId, Pending/Graveyard OU ids, Identity Center ids); fail-fast on disagreement (no auto-repair — bootstrap's job).
  - [ ] map to domain model with name-uniqueness assertions (accounts globally, OU names globally for picklist validity, groups, users, permission sets).
- [ ] Implement codegen for `aws.config.ts` and `aws.config.types.ts` with deterministic ordering (OUs depth-first then alphabetical; everything else alphabetical).
- [ ] Implement `aws.config.ts` loader (esbuild compile to temporary `.mjs` → dynamic `import()` → validate against `awsConfigSchema` → cleanup).
- [ ] Implement `init` command (orchestration only — calls existing command functions):
  - [ ] call `runBootstrapCommand` (writes `aws.context.json`).
  - [ ] call `runScanCommand` (writes `state.json`).
  - [ ] call state → config transform and codegen to write `aws.config.ts` + `aws.config.types.ts`.
- [ ] Implement `regenerate` command:
  - [ ] load `aws.config.ts` via loader.
  - [ ] re-emit `aws.config.types.ts` only (does not modify `aws.config.ts`) so picklists pick up manual edits.
- [ ] Add non-destructive file write behavior:
  - [ ] compute target file content, compare to existing.
  - [ ] no changes → log "no changes" and exit cleanly.
  - [ ] changes → print per-file byte summary plus `git diff` hint, then call confirmation callback (CLI handles `--yes` and TTY checks like `bootstrap`).
- [ ] Add tests for transform correctness, name-uniqueness rejection, assignment grouping, sort stability under shuffled input.
- [ ] Add tests for `init` command (sequences bootstrap → scan → config write with mocked clients).
- [ ] Add tests for `regenerate` command (loads fixture config, re-emits types, no-op when unchanged, confirmation rejected paths).
- [ ] Add CLI summary showing per-file change status (written / unchanged / would-write).

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
  - [ ] `plan` (load `aws.config.ts` → transform to next `state.json` shape → diff current `state.json` vs next; emit operations list).
  - [ ] `apply` (execute approved operations directly via AWS SDK in CLI for increment 1).
- [ ] Implement `mapAwsConfigToState` transform:
  - [ ] load `aws.config.ts` via the phase 3 loader.
  - [ ] resolve names to AWS-issued ids using current `state.json` (entities present in both keep their existing ids; entities only in config get placeholder ids interpreted by the diff as "to be created").
- [ ] Implement state-vs-state diff engine producing human-readable and machine-readable plan.
- [ ] Define operation model for supported mutations in increment 1:
  - [ ] move account between OUs
  - [ ] add account metadata entries
- [ ] Exclude IAM Identity Center assignment mutations from increment 1 apply scope.
- [ ] Implement safety policy:
  - [ ] default no destructive actions
  - [ ] explicit guardrails for unsupported/destructive diffs
  - [ ] require confirmation before apply (interactive prompt)
  - [ ] support non-interactive approval via `--yes`
- [ ] Implement apply executor with per-operation progress + final outcome summary.
- [ ] After apply succeeds, write the post-apply state to `state.json` from the planned-next-state. Do not regenerate `aws.config.ts`. Do not auto re-scan in the normal apply loop.
- [ ] Add tests for `mapAwsConfigToState`, plan generation (state-vs-state), and apply sequencing.

## Out of scope for increment 1

- Drift detection / sync from AWS into `aws.config.ts` after init. Manual changes made in the AWS Console outside this tool are not detected or merged. A future "sync" feature may address this.
- Automatic re-scan in the normal `apply` loop. State updates after apply come from the planned-next-state, not a fresh scan.
- Watcher mode for `regenerate`. A future `watch` command will run `regenerate` on `aws.config.ts` change; for increment 1 the user runs it manually.
- IAM Identity Center mutation operations in `apply` (creating users / groups / assignments).
- Cloud-backed flow: Lambda deployment, S3 state storage, signed-URL state download. Increment 1 is local-only.

## Cross-cutting implementation checklist

- [x] Keep CLI logic in one primary file (helpers extracted only when reused).
- [ ] Keep Lambda handler code in one file (placeholder only in increment 1 if not used yet).
- [x] Use esbuild for build outputs and local run wiring.
- [x] Use TypeScript 6+ conventions and camelCase naming.
- [x] Avoid barrel files.
- [ ] Add consistent error model and exit codes for CLI commands.
- [ ] Add README usage notes for local increment commands and safety constraints.
