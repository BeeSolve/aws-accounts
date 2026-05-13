# Increment 1 plan (local-only) — **v1 complete**

This file is the historical plan for the **local-first v1** CLI. The original “increment 1” scope excluded destructive mutations and IAM Identity Center writes; **v1 as shipped** adds gated destructive operations (for example empty OU deletion and parking removed accounts in `Graveyard`), full IAM Identity Center reconciliation in `apply`, account tags and display-name reconciliation, `plan --json` destructive summaries, and the `graveyard` command. **v2** is still expected to add Lambda/S3-backed execution and saved plan artifacts (see README “Deferred after v1” and `docs/v1-backlog-priority.md`).

---

Scope for the original increment (superseded in places by v1 as noted above):
- Run locally via `npm run cli`.
- No Lambda deployment/invocation (v2).
- No S3 usage (v2).
- Destructive AWS changes are **opt-in** via explicit flags and confirmations (`apply --allow-destructive`, interactive preview); v1 does not auto-apply destructive work.
- Build foundations so cloud-backed flow can be layered in later increments.
- Repository-root files for v1: `state.json`, `aws.config.ts`, `aws.context.json`.

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

## Phase 2: Bootstrap OUs (Graveyard) locally-first flow

- [x] Define bootstrap command contract (`bootstrap`) for local-first mode (no Lambda/S3 setup in increment 1).
- [x] Define idempotent logic to ensure required OUs exist: `Graveyard`.
- [x] Implement read-before-write checks to avoid duplicate OU creation.
- [x] Implement OU creation in AWS Organizations for missing required OUs (`Graveyard`).
- [x] Implement safe guards:
  - [x] no deletion
  - [x] no re-parenting except explicitly required by command scope
  - [x] clear prompt/log before any create operation
- [x] Persist discovered/created OU IDs into local context file (`aws.context.json`).
- [x] Ensure generated/updated context structure is future-compatible with later Lambda/S3 fields.
- [x] Add tests for bootstrap decision logic (exists vs create).
- [x] Add CLI summary showing OU actions planned/executed.

## Phase 3: First-time `init` and config-driven type regeneration

- [x] Define `init` CLI command contract that orchestrates `bootstrap` + `scan` + state→config write. Supports `--profile`, `--region`, `--instance-arn`, `--yes`.
- [x] Define `regenerate` CLI command contract that refreshes `aws.config.types.ts` from the current `aws.config.ts`. Supports `--yes`.
- [x] Define internal domain model that maps raw scanned state to config representation:
  - [x] single `organizationalUnits` list with synthetic `{ name: "root", parentName: null }` entry holding accounts that live directly under the organization root.
  - [x] account references as `{ name, email }`; cross-references by name throughout (no AWS-issued ids/arns in `aws.config.ts`).
  - [x] assignments grouped by `(principal, permissionSet)` with `accounts: string[]`.
  - [x] exclude `accessRoles` (derivable from `permissionSet` + `accountId`).
- [x] Define generated `aws.config.types.ts` exporting both the valibot schema (`awsConfigSchema`) and the inferred `AwsConfig` type:
  - [x] picklists for cross-references: OU names (used in `parentName`), account names, permission set names, group display names, user user names.
  - [x] entity `name` fields (where the name is *defined*, not referenced) stay plain `v.string()`.
  - [x] `parentName` typed as `v.union([organizationalUnitNameSchema, v.null_()])`.
- [x] Define deterministic codegen format for `aws.config.ts` (stable key ordering, readable structure).
- [x] Implement state → config transform (`mapStateToAwsConfig`):
  - [x] load and validate `state.json`.
  - [x] cross-validate against `aws.context.json` (rootId, Graveyard OU id, Identity Center ids); fail-fast on disagreement (no auto-repair — bootstrap's job).
  - [x] map to domain model with name-uniqueness assertions (accounts globally, OU names globally for picklist validity, groups, users, permission sets).
- [x] Implement codegen for `aws.config.ts` and `aws.config.types.ts` with deterministic ordering (OUs depth-first then alphabetical; everything else alphabetical).
- [x] Implement `aws.config.ts` loader (esbuild compile to temporary `.mjs` → dynamic `import()` → validate against `awsConfigSchema` → cleanup).
- [x] Implement `init` command (orchestration only — calls existing command functions):
  - [x] call `runBootstrapCommand` (writes `aws.context.json`).
  - [x] call `runScanCommand` (writes `state.json`).
  - [x] call state → config transform and codegen to write `aws.config.ts` + `aws.config.types.ts`.
- [x] Implement `regenerate` command:
  - [x] load `aws.config.ts` via loader.
  - [x] re-emit `aws.config.types.ts` only (does not modify `aws.config.ts`) so picklists pick up manual edits.
- [x] Add non-destructive file write behavior:
  - [x] compute target file content, compare to existing.
  - [x] no changes → log "no changes" and exit cleanly.
  - [x] changes → print per-file byte summary plus `git diff` hint, then call confirmation callback (CLI handles `--yes` and TTY checks like `bootstrap`).
- [x] Add tests for transform correctness, name-uniqueness rejection, assignment grouping, sort stability under shuffled input.
- [x] Add tests for `init` command (sequences bootstrap → scan → config write with mocked clients).
- [x] Add tests for `regenerate` command (loads fixture config, re-emits types, no-op when unchanged, confirmation rejected paths).
- [x] Add CLI summary showing per-file change status (written / unchanged / would-write).

## Phase 4: Implement account creation (config-driven through plan/apply)

- [x] Account creation is emitted by `plan` as `createAccount` for newly authored config accounts.
- [x] `apply` executes account creation directly in the target OU (no Pending staging OU).
- [x] Creation path uses polling and clear progress/failure feedback.
- [x] Add tests for command validation and config/state update logic.

## Phase 5: Implement add/modify flow (config-driven reconciliation)

> Design decisions: [`docs/phase-5-decisions.md`](docs/phase-5-decisions.md). Working plan with file paths and ordering: [`docs/phase-5-plan.md`](docs/phase-5-plan.md).

- [x] Define reconciliation command pair for local mode:
  - [x] `plan` (load `aws.config.ts` → transform to next `state.json` shape → diff current `state.json` vs next; emit operations list).
  - [x] `apply` (execute approved operations directly via AWS SDK in the CLI for v1).
- [x] Implement `mapAwsConfigToState` transform:
  - [x] load `aws.config.ts` via the phase 3 loader.
  - [x] resolve names to AWS-issued ids using current `state.json` (entities present in both keep their existing ids; entities only in config get placeholder ids interpreted by the diff as "to be created").
- [x] Implement state-vs-state diff engine producing human-readable and machine-readable plan.
- [x] Define operation model for supported mutations (see README for the full v1 list).
  - [x] move account between OUs
  - [x] create OU under a known parent OU
  - [x] rename OU via strict same-parent one-to-one heuristic
  - [x] create account directly in a known target OU
- [x] IAM Identity Center mutations in `apply` (users, groups, memberships, permission sets, policies, assignments, provisioning, gated removals, metadata updates — see README)
- [x] Account metadata in `apply` for tags and member account display name (alternate contacts remain post-v1)
- [x] Implement safety policy:
  - [x] supported destructive operations are off by default (`apply` requires `--allow-destructive` where applicable)
  - [x] strict default: refuse apply when any unsupported diff is present
  - [x] `--ignore-unsupported` flag proceeds past non-destructive unsupported diffs only
  - [x] destructive unsupported diffs always refuse `apply` (no override); supported destructive operations require `--allow-destructive`
  - [x] require confirmation before apply (interactive prompt)
  - [x] support non-interactive approval via `--yes`
- [x] Implement apply executor with per-operation progress + final outcome summary.
- [x] After apply succeeds, write the post-apply state to `state.json` from the planned-next-state. Do not regenerate `aws.config.ts`. Do not auto re-scan in the normal apply loop.
- [x] On per-operation failure during apply: abort, persist `state.json` reflecting only successful ops, exit non-zero with guidance to run `scan` then re-`apply`.
- [x] Add tests for `mapAwsConfigToState`, plan generation (state-vs-state), and apply sequencing.
  - [x] `mapAwsConfigToState` coverage (sentinel IDs, root resolution, stable id reuse)
  - [x] plan generation (state-vs-state diff engine + `plan` command output modes)
  - [x] apply sequencing and failure persistence

## Out of scope for v1 (deferred to v2+)

- Drift detection / sync from AWS into `aws.config.ts` after init. Manual changes made in the AWS Console outside this tool are not detected or merged. A future "sync" feature may address this.
- Automatic re-scan in the normal `apply` loop. State updates after apply come from the planned-next-state, not a fresh scan.
- Watcher mode for `regenerate`. A future `watch` command will run `regenerate` on `aws.config.ts` change; for v1 the user runs it manually.
- Cloud-backed flow: Lambda deployment, S3 state storage, signed-URL state download.
- Saved plan artifact (Terraform-style `plan.json` for separate `plan` then `apply` runs across sessions / pipelines). `apply` recomputes the plan inline in v1.
- Alternate contacts and other account metadata not yet modeled in `aws.config.ts` / `apply` (see `docs/v1-backlog-priority.md`).

## Cross-cutting implementation checklist

- [x] Keep CLI logic in one primary file (helpers extracted only when reused).
- [x] Keep Lambda handler code in one file (placeholder deferred to v2 with cloud-backed flow; intentionally not implemented in v1).
- [x] Use esbuild for build outputs and local run wiring.
- [x] Use TypeScript 6+ conventions and camelCase naming.
- [x] Avoid barrel files.
- [x] Add consistent error model and exit codes for CLI commands.
- [x] Add README usage notes for local increment commands and safety constraints.
