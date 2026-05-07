# Phase 5 Plan: `plan` and `apply` Reconciliation

This is the working implementation plan. Design decisions live in `docs/phase-5-decisions.md`. As tasks complete, tick boxes here and propagate status to `plan.md`.

## Overview

Phase 5 introduces config-driven reconciliation: user edits `aws.config.ts`, runs `plan` to see the diff vs current `state.json`, then `apply` to execute supported mutations against AWS. After successful apply, `state.json` is rewritten from the planned-next-state (no re-scan in the normal loop).

Increment 1 supported mutations: **moving accounts between OUs**. Account metadata reconciliation (tags, alternate contacts, account-name drift) is deferred — see `docs/phase-5-decisions.md`.

## Resolved decisions (summary)

Full reasoning lives in `docs/phase-5-decisions.md`. Quick reference:

1. **Account metadata reconciliation — deferred.** `aws.config.ts` keeps `account: { name, email }`. Tags / `PutAccountName` / alternate contacts / etc. are out of scope for increment 1; tags are the likely next-up in a follow-up increment. Schema stays open for additive growth.
2. **Plan artifact — recompute on apply (no artifact).** `apply` re-runs the plan logic inline, prints summary, confirms, executes. Saved plan artifact (Terraform-style `plan.json` with state-fingerprint validation) is deferred to increment 2 alongside the cloud-backed flow.
3. **Unsupported diffs — strict refuse with one escape hatch.** Plan output always includes both supported and unsupported diffs. Apply refuses by default. `--ignore-unsupported` proceeds past *non-destructive* unsupported diffs only (new OU, IdC additions, sentinel new account). Destructive unsupported diffs (account removal from config, OU deletion) always refuse — no flag override.
4. **Partial-failure recovery — abort + persist partial.** On first operation failure during apply, stop. Write `state.json` reflecting only the ops that succeeded. Exit non-zero with explicit next-step guidance: run `scan` to verify reality, then re-run `apply`. No automatic rollback.

`README.md` must document the apply flags (`--yes`, `--ignore-unsupported`) and the partial-failure recovery loop (`scan` then re-`apply`) once Phase 5 ships. Tracked under the existing cross-cutting "Add README usage notes" item in `plan.md`.

## Phase 5.0: Capture decisions

- [x] Write `docs/phase-5-decisions.md` covering: operation model, plan-vs-apply lifecycle, unsupported-diff handling, partial-failure recovery, why apply recomputes the plan.

## Phase 5.1: Operation model

- [x] Add `src/operations.ts` using **Valibot schema-first** definitions (repo-consistent pattern):
  - `moveAccountOperationSchema` and `operationSchema = v.variant('kind', [...])`; increment 1 has `{ kind: 'moveAccount', accountId, accountName, fromOuId, fromOuName, toOuId, toOuName }`.
  - `unsupportedDiffKindSchema` (`v.picklist`), `unsupportedDiffCategorySchema` (`'destructive' | 'unsupportedMutation'`), and `unsupportedDiffSchema`.
  - `planSchema = { operations, unsupported }`.
  - Inferred types only: `MoveAccountOperation`, `Operation`, `UnsupportedDiff`, `UnsupportedDiffKind`, `Plan` via `v.InferOutput`.
- [x] Keep names alongside ids on each op so log output doesn't need extra lookups.

## Phase 5.2: `mapAwsConfigToState` transform

- [x] Add `mapAwsConfigToState` in `src/awsConfig.ts` (sits next to existing `mapStateToAwsConfig` at `src/awsConfig.ts:319`).
- [x] Signature: `mapAwsConfigToState(props: { config: AwsConfigModel; currentState: StateFile; context: AwsContextFile }): StateFile`.
- [x] Behavior:
  - For entities present in both config and state (matched by name), copy AWS-issued ids from current state.
  - For entities only in config, emit a sentinel id via `pendingCreationId = "__pending_creation__" as const`. Diff engine treats sentinel ids as "to-create" markers.
  - Synthetic `{ name: 'root', parentName: null }` OU resolves to `context.organization.rootId`.
  - `Pending` and `Graveyard` resolved from `context` (not state) for stability.
  - Account assignments are flattened back from `(principal, permissionSet, accounts[])` into one row per `(principal, permissionSet, accountId)`.
- [x] Validation: name uniqueness re-checked (defense in depth even though `awsConfigSchema` enforces picklists).
- [x] Returns a `StateFile` shaped like `state.json` but with sentinel ids where AWS ids are unknown.
- [ ] Add/extend tests for `mapAwsConfigToState` behavior (tracked in Phase 5.7).

## Phase 5.3: Diff engine

- [x] Add `src/diff.ts` exporting `diffStates(props: { current: StateFile; next: StateFile }): Plan`.
- [x] Compare current vs next at entity level:
  - Account `parentId` differs and both ids are real → emit `moveAccount` op.
  - Account in next has sentinel id → `unsupportedMutation` (account creation goes through Phase 4).
  - OU added in config → `unsupportedMutation`.
  - OU renamed → `unsupportedMutation`.
  - OU removed in config → `destructive`.
  - IdC entity diffs (users, groups, permission sets, assignments) → `unsupportedMutation`.
  - Account removed from config (not present in next) → `destructive`.
- [x] Determinism: `operations` sorted by `accountName`; `unsupported` sorted by `kind` then `description`.
- [x] Returns `Plan`; never throws on unsupported diffs (let the command layer decide policy).

### Phase 5.3 compact test matrix (`src/diff.test.ts`)

1. **No diff baseline**
   - current equals next
   - expect `operations: []`, `unsupported: []`
2. **Single move**
   - one account has different `parentId` with real ids on both sides
   - expect one `moveAccount` operation with correct from/to ids and names
3. **Multiple moves deterministic order**
   - two+ account moves in unsorted input order
   - expect `operations` sorted by `accountName`
4. **New account sentinel**
   - next contains account absent from current with id `__pending_creation__`
   - expect one unsupported entry: `kind: "newAccount"`, `category: "unsupportedMutation"`
5. **Destructive removals**
   - account exists in current but not in next
   - OU exists in current but not in next
   - expect `removedAccount` + `removedOu`, both `category: "destructive"`
6. **OU add + rename classification**
   - added OU only -> `newOu`
   - added OU + removed OU under same parent -> `renamedOu` (unsupported)
7. **IdC additions**
   - add user/group/permission set in next
   - expect `idcUserAdded`, `idcGroupAdded`, `idcPermissionSetAdded`
8. **IdC assignment change**
   - account assignments differ between current and next
   - expect `idcAssignmentChanged`

## Phase 5.4: `plan` command

- [x] Add `src/commands/plan.ts` exporting `runPlanCommand(props: { configPath, typesPath, statePath, contextPath, output: 'human' | 'json' }): Promise<PlanCommandResult>`.
- [x] Steps:
  1. Load `aws.config.ts` via existing `loadAwsConfigFromTsFile` (`src/awsConfig.ts:809`).
  2. Read `state.json` via existing `readStateFile` (`src/state.ts`).
  3. Read `aws.context.json`.
  4. Call `mapAwsConfigToState` → `nextState`.
  5. Call `diffStates({ current, next })` → `plan`.
  6. Format and print (human-readable by default; `--json` for machine consumption). Human format includes unsupported `category` for apply-gate visibility.
- [x] No AWS calls — `plan` is read-only locally. Don't construct AWS clients.
- [x] CLI registration in `src/cli.ts` next to existing commands. No `planConfirmation` callback needed.
- [x] Exit code: 0 always (a diff is informational, not a gate); 1 only on errors.

## Phase 5.5: `apply` command

- [x] Add `src/commands/apply.ts` exporting `runApplyCommand(props: { organizationsClient: OrganizationsClient; configPath; typesPath; statePath; contextPath; ignoreUnsupported; planConfirmation }): Promise<ApplyCommandResult>`.
- [x] Steps:
  1. Recompute plan (calls into Phase 5.4's pure parts — extract a `computePlan()` helper from `runPlanCommand` to share).
  2. If `unsupported` contains any `category: 'destructive'` items → refuse with non-zero exit (no flag override). Else, if `unsupported` contains `category: 'unsupportedMutation'` items and `!ignoreUnsupported` → refuse with non-zero exit listing the items. Else → proceed.
  3. If `operations.length === 0`, log "no changes" and exit 0.
  4. Print the plan summary, call `planConfirmation(planLines)` (reuses bootstrap's pattern at `src/cli.ts:204`).
  5. Execute operations sequentially via `OrganizationsClient`:
     - `moveAccount` → `MoveAccountCommand({ AccountId, SourceParentId, DestinationParentId })`.
  6. After each successful op, mutate an in-memory copy of `nextState` so partial failures know what succeeded.
  7. On any failure: log error, write the partially-updated state to `state.json`, exit non-zero with actionable message ("run `scan` to verify, then re-run `apply`").
  8. On full success: write `nextState` to `state.json`. Do NOT regenerate `aws.config.ts`. Do NOT auto-rescan.
- [x] CLI registration with `--yes`, `--ignore-unsupported` flags. Reuse `buildBootstrapPlanConfirmation` (or rename to `buildPlanConfirmation` if shared between bootstrap and apply).

## Phase 5.6: State persistence helper

- [x] Add (or reuse) a `writeStateFile` helper in `src/state.ts` that writes `state.json` with the existing deterministic ordering used by scan. Likely already present — verify and reuse rather than duplicate.

## Phase 5.7: Tests (Node `--test`, mirror existing patterns from `src/commands/bootstrap.test.ts`)

- [ ] `src/awsConfig.test.ts` (extend) — `mapAwsConfigToState`:
  - Round-trip: `mapStateToAwsConfig(mapAwsConfigToState({ config, currentState })) ≈ config` for unchanged inputs.
  - Sentinel ids emitted for entities not in current state.
  - Synthetic `root` OU resolves to `context.rootId`.
- [x] `src/diff.test.ts`:
  - [x] No-diff case (current == next).
  - [x] Single account move detected.
  - [x] Multiple moves: deterministic order.
  - [x] OU added → `unsupportedMutation`.
  - [x] OU renamed → `unsupportedMutation`.
  - [x] OU removed → `destructive`.
  - [x] Account removed from config → `destructive`.
  - [x] IdC change → `unsupportedMutation`.
  - [x] Sentinel id (new account) → `unsupportedMutation`.
- [x] `src/commands/plan.test.ts`:
  - [x] Fixture workspace with `state.json` + `aws.config.ts` → expected plan output.
  - [x] `--json` output shape.
  - [x] Unsupported diffs include category labels in human output.
- [x] `src/commands/apply.test.ts`:
  - [x] Mock `OrganizationsClient`; assert `MoveAccountCommand` called with correct ids.
  - [x] Confirmation rejected → no SDK calls, exit cleanly.
  - [x] Destructive unsupported diff → refuses regardless of `--ignore-unsupported`.
  - [x] Non-destructive unsupported diff with `--ignore-unsupported` → proceeds with supported ops only.
  - [x] Partial failure: 2 ops, 2nd fails → `state.json` reflects only 1st op; non-zero exit.
  - [x] Successful apply rewrites `state.json`; does not touch `aws.config.ts`.

## Phase 5.8: CLI wiring & output

- [x] Register `plan` and `apply` in `src/cli.ts` alongside existing commands; reuse arg parsing + client construction patterns from `bootstrap` / `init`.
- [ ] Match existing `console.log` style (no logger abstraction yet — that's the open cross-cutting item in `plan.md`).
- [x] Plan output format (human):

  ```
  Plan: 2 operations, 1 unsupported diff
    move account "dev-sandbox" (123…) from Pending → Engineering
    move account "data-prod"   (456…) from Pending → Data
  Unsupported diffs (will not apply):
    new OU "Marketing" (creation not supported in increment 1)
  ```

- [x] Apply output: per-op start/done lines, final summary.

## File-touch summary

**New:**

- `src/operations.ts`
- `src/diff.ts`
- `src/diff.test.ts`
- `src/commands/plan.ts`
- `src/commands/plan.test.ts`
- `src/commands/apply.ts`
- `src/commands/apply.test.ts`
- `docs/phase-5-decisions.md` ✅ (done)

**Modified:**

- `src/awsConfig.ts` (add `mapAwsConfigToState`)
- `src/awsConfig.test.ts` (round-trip tests)
- `src/cli.ts` (register `plan`, `apply`)
- `src/state.ts` (only if `writeStateFile` helper isn't already present)
- `plan.md` (tick boxes as phases complete)
- `README.md` (document apply flags and partial-failure recovery — once phase 5 ships)

## Suggested implementation order

1. ✅ Decisions doc (5.0).
2. Operation model (5.1) — tiny, unblocks everything.
3. `mapAwsConfigToState` + tests (5.2).
4. Diff engine + tests (5.3).
5. `plan` command + tests (5.4) — read-only, end-to-end exercise of 5.2 / 5.3.
6. `apply` command + tests (5.5) — only AWS mutation in the phase.
7. CLI wiring & polish (5.8).
