# Phase 5.5 Handoff: `apply` Command

This document is a review-first implementation plan for Phase 5.5 only.
No assumptions from chat context are required.

## Scope

- Implement `apply` command in local mode.
- Recompute plan from files (no saved plan artifact in increment 1).
- Execute only supported operations (`moveAccount`).
- Enforce unsupported-diff policy gates exactly as decided.
- Persist `state.json` on success and partial failure.

## Locked decisions

- `apply` is mutation-capable and requires `OrganizationsClient` via props.
- No AWS client construction inside command module.
- No rollback on partial failure.
- On failure after partial progress: persist partial state and exit non-zero with recovery guidance.
- Destructive unsupported diffs always refuse (no override).
- `--ignore-unsupported` only bypasses non-destructive unsupported diffs.
- Command module props should be explicit and required; CLI owns defaults.
- Keep user interaction (`--yes`, TTY prompts) in `cli.ts`.

## Proposed file changes

- **New**: `src/commands/apply.ts`
- **New**: `src/commands/apply.test.ts`
- **Modify**: `src/cli.ts` (register `apply`, parse `--ignore-unsupported`)
- **Optional extraction (later, only if approved in separate step)**:
  - shared compute/format helpers to `src/reconciliation.ts`

## Command contract (proposed)

```ts
type ApplyCommandInput = {
  organizationsClient: OrganizationsClient;
  configPath: string;
  typesPath: string;
  statePath: string;
  contextPath: string;
  ignoreUnsupported: boolean;
  planConfirmation: (props: { planLines: string[] }) => Promise<boolean>;
};

type ApplyCommandResult = {
  plan: Plan;
  appliedOperations: number;
  statePath: string;
  status: "applied" | "no-changes" | "cancelled" | "refused";
};
```

## Implementation steps (`src/commands/apply.ts`)

1. **Load/compute plan**
   - Read state/config/context.
   - Build `nextState` via `mapAwsConfigToState`.
   - Build `plan` via `diffStates`.
2. **Policy gate**
   - If any unsupported with `category: "destructive"`:
     - print list and refuse (`status: "refused"`), throw error for non-zero exit.
   - Else if unsupported exists and `ignoreUnsupported === false`:
     - print list and refuse (`status: "refused"`), throw error.
   - Else continue; if bypassing unsupported via flag, print that supported ops only will execute.
3. **No-op exit**
   - If `plan.operations.length === 0`:
     - print no-op summary, return `status: "no-changes"`.
4. **Confirmation**
   - Build plan lines for user review.
   - Call `planConfirmation`.
   - If declined: return `status: "cancelled"` with no SDK calls and no state write.
5. **Sequential execution**
   - Iterate `plan.operations` in order.
   - For `moveAccount`:
     - call `MoveAccountCommand({ AccountId, SourceParentId, DestinationParentId })`.
   - After each success, mutate in-memory progressed state so partial persistence is accurate.
6. **Persistence**
   - Full success: write `nextState` via `writeStateFile`.
   - First failure:
     - write progressed partial state via `writeStateFile`
     - throw error with actionable recovery text:
       - run `npm run cli -- scan`
       - then re-run `apply`

## CLI wiring plan (`src/cli.ts`)

1. Add `ignore-unsupported` boolean parse option (default `false`).
2. Implement `apply` command branch:
   - create `OrganizationsClient`
   - build confirmation callback (reuse existing pattern)
   - pass explicit paths:
     - `aws.config.ts`
     - `aws.config.types.ts`
     - `state.json`
     - `aws.context.json`
3. Update help text for:
   - `apply [--yes] [--ignore-unsupported]`

## Output format plan

- Start: `Apply: <ops> operation(s), <unsupported> unsupported diff(s)`
- Per op:
  - `Moving "<accountName>" (<accountId>): <fromOuName> -> <toOuName>`
  - `Done: "<accountName>"`
- Unsupported gate:
  - `Unsupported diffs:`
  - `- <description> [<category>]`
- Success:
  - `Apply complete. Applied <N> operation(s).`
- Partial failure:
  - `Aborted after <K> of <N> operations.`
  - `state.json updated for successful operations.`
  - `Run 'npm run cli -- scan' to verify, then re-run apply.`

## Test matrix (`src/commands/apply.test.ts`)

1. **Destructive unsupported always refuses**
   - Include destructive unsupported in plan input.
   - Expect refusal regardless of `ignoreUnsupported`.
2. **Non-destructive unsupported refuses without flag**
   - Unsupported only in `unsupportedMutation`.
   - `ignoreUnsupported: false` => refuse.
3. **Non-destructive unsupported proceeds with flag**
   - `ignoreUnsupported: true` => execute supported ops.
4. **Confirmation rejected**
   - Plan has operations.
   - `planConfirmation` returns false.
   - Expect no SDK call, no state write.
5. **Happy path move**
   - one `moveAccount` op.
   - assert `MoveAccountCommand` input matches plan fields.
   - assert final `state.json` written once.
6. **Partial failure**
   - op1 succeeds, op2 throws.
   - assert partial state persisted.
   - assert error message contains scan/retry guidance.

## Suggested delivery order

1. Implement `src/commands/apply.ts` command logic.
2. Add `apply` CLI branch and `--ignore-unsupported`.
3. Add tests in `src/commands/apply.test.ts`.
4. Run:
   - `npm run typecheck`
   - `npm test`
5. Update progress docs:
   - `docs/phase-5-plan.md`
   - `plan.md`

## Review checklist (before coding)

- [x] Props required (no optional defaults in command module).
- [x] Gate logic matches destructive/non-destructive policy exactly.
- [x] Confirmation happens after plan print, before AWS calls.
- [x] Partial failure path writes state and returns actionable guidance.
- [x] Tests cover refusal, success, and partial-failure persistence.

---

## Follow-up refactor (separate, optional)

### Goal

Adopt `assertUnreachable` in `mapAssignmentPrincipal` by tightening `principalType` from generic string to a literal union.

### Why separate

- Not required for phase 5.5 behavior.
- Safer to review as a focused type/schema refactor.

### Candidate location

- `src/awsConfig.ts` → `mapAssignmentPrincipal(...)`

### Proposed changes

1. Tighten state schema for assignment principal type in `src/state.ts`:
   - from: `principalType: nonEmptyString`
   - to: `principalType: v.picklist(["GROUP", "USER"])`
2. Re-run `v.InferOutput` so TypeScript type becomes `"GROUP" | "USER"`.
3. Update `mapAssignmentPrincipal(...)` fallback from generic throw to:
   - `assertUnreachable(props.assignment.principalType, "...")`
4. Keep runtime error messaging clear for invalid external inputs (validation already handles this).

### Test updates

- Add/adjust tests in `src/state.test.ts` to assert invalid `principalType` is rejected by schema.
- Ensure existing `awsConfig`/scan tests still pass under stricter type.

### Suggested commit scope

- `src/state.ts`
- `src/awsConfig.ts`
- `src/state.test.ts` (and any affected tests)

### Status

- [x] Completed in current working tree.
