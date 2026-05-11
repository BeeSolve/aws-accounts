# Phase 6 Plan: Expand `plan`/`apply` Supported Actions

This plan defines how to extend reconciliation beyond increment 1 (`moveAccount` only) by implementing currently unsupported diffs detected in `src/diff.ts` / `src/operations.ts`.

## Goal

Support additional safe, config-driven mutations in `plan`/`apply` while preserving:

- deterministic planning output
- strict safety gates for destructive actions
- partial-failure persistence model (`state.json` write + recovery guidance)

## Current unsupported actions (from code)

The current `UnsupportedDiffKind` set is:

1. `newOu` (unsupportedMutation)
2. `renamedOu` (unsupportedMutation)
3. `removedOu` (destructive)
4. `idcUserAdded` (unsupportedMutation)
5. `idcGroupAdded` (unsupportedMutation)
6. `idcPermissionSetAdded` (unsupportedMutation)
7. `idcAssignmentChanged` (unsupportedMutation)
8. `newAccount` (unsupportedMutation)
9. `removedAccount` (destructive)

## Proposed delivery strategy

Ship in waves, highest value + safest first.

### Wave 1 (recommended first): Organizations non-destructive expansion

Implement:

- `newOu`
- `renamedOu`
- `newAccount` (reconcile path with direct target-OU creation in apply)

Keep unsupported:

- `removedOu`
- `removedAccount`
- all IdC mutations

### Wave 2: Identity Center additive/membership mutations

Implement:

- `idcUserAdded`
- `idcGroupAdded`
- `idcPermissionSetAdded`
- `idcAssignmentChanged`

Keep unsupported/destructive:

- `removedOu`
- `removedAccount`

### Wave 3 (optional, explicit approval only): destructive operations

Consider:

- `removedOu`
- `removedAccount`

Only with strict two-step confirm and extra safeguards.

## Operation model expansion

Add new operation variants in `src/operations.ts`:

- `createOu`
- `renameOu`
- `createAccount`
- `createIdcUser`
- `createIdcGroup`
- `createIdcPermissionSet`
- `setIdcAssignments`

Notes:

- Keep names + ids together on every operation for log clarity.
- Continue schema-first Valibot pattern (`v.variant("kind", [...])`).
- Keep unsupported kinds for actions not yet implemented (or intentionally blocked).

## Diff engine changes (`src/diff.ts`)

Refactor from "unsupported classification only" to "emit operation where supported":

1. `newOu` -> `createOu` operation (when parent exists / resolvable).
2. `renamedOu` -> `renameOu` operation (exact-match rename heuristic remains explicit).
3. `newAccount` -> `createAccount` operation (instead of unsupported marker).
4. IdC additions/assignment changes -> dedicated IdC operations in Wave 2.
5. Keep `removedOu` / `removedAccount` as destructive unsupported until Wave 3.

Determinism:

- Sort operations by stable key: `kind`, then entity name, then parent/target.

## Apply executor changes (`src/commands/apply.ts`)

### Common

- Extend `applyOperation(...)` and `applyOperationToState(...)` for each new operation kind.
- Keep sequential execution and partial-failure persistence unchanged.

### Wave 1 details

- `createOu`:
  - `CreateOrganizationalUnitCommand`
  - resolve parent id from context/state
  - update in-memory state with created OU id/arn
- `renameOu`:
  - `UpdateOrganizationalUnitCommand`
  - update in-memory OU name
- `createAccount`:
  - reuse/create shared account-creation helper (currently in `createAccount` command)
  - includes polling + move to Pending if target requires
  - update in-memory state with account id/arn/parent

### Wave 2 details

- use `sso-admin` + `identitystore` clients in apply input
- implement creation and assignment mutation operations with id resolution
- update in-memory identity center sections consistently

## CLI and policy changes

- Add new flags only if necessary (prefer no new flags in Wave 1/2).
- Keep `--ignore-unsupported` semantics identical.
- Update IAM permissions section in README for any newly required APIs.

## Safety model updates

Maintain defaults:

- destructive diffs still refuse by default
- `--ignore-unsupported` only bypasses non-destructive unsupported items

If Wave 3 is attempted:

- add `--allow-destructive` (and keep interactive confirmation mandatory)
- require explicit plan summary section "DESTRUCTIVE ACTIONS"
- consider a second typed confirmation prompt in TTY mode

## Tests plan

### `src/operations.test.ts` (new)

- schema parse success/fail for each new operation variant.

### `src/diff.test.ts` updates

- each currently unsupported kind covered in both:
  - "still unsupported" mode (before wave)
  - "now operation" mode (after wave implementation)

### `src/commands/apply.test.ts` updates

- per-operation SDK call assertions
- mixed-operation sequencing
- partial failure with each new operation kind
- state persistence correctness after partial and full success

### Integration-focused tests

- plan output includes new operation lines with deterministic order
- apply with `--ignore-unsupported` executes supported subset only

## Suggested implementation order

1. Introduce operation schema variants + tests.
2. Implement Wave 1 diff emission for `newOu` and `renamedOu`.
3. Implement Wave 1 apply execution for OU create/rename.
4. Implement `newAccount` as reconcile operation (shared helper with create-account command).
5. Update plan/apply tests for Wave 1.
6. Review behavior and decide whether to proceed with Wave 2 IdC support.

## Open decisions for review

1. `newAccount` in apply uses direct target-OU creation (not Pending-first).
2. `renamedOu` uses strict one-to-one same-parent heuristic only; ambiguous cases remain unsupported.
3. IdC mutations are deferred to a separate Wave 2 after Wave 1 stabilization.
4. Destructive actions remain out-of-scope and hard-refused in this phase.

## Implementation checklist (progress tracker)

### Phase 6.0: Design lock

- [x] Confirm Wave 1 scope (`newOu`, `renamedOu`, `newAccount`) and deferments.
- [x] Confirm `newAccount` behavior in apply (direct target-OU creation).
- [x] Confirm rename heuristic policy for OU rename detection (strict one-to-one same-parent only).
- [x] Confirm whether destructive actions remain out-of-scope for local mode (hard-refused).

### Phase 6.1: Operation model expansion (`src/operations.ts`)

- [x] Add `createOu` operation schema + inferred type.
- [x] Add `renameOu` operation schema + inferred type.
- [x] Add `createAccount` operation schema + inferred type.
- [ ] (Wave 2) Add `createIdcUser` operation schema + inferred type.
- [ ] (Wave 2) Add `createIdcGroup` operation schema + inferred type.
- [ ] (Wave 2) Add `createIdcPermissionSet` operation schema + inferred type.
- [ ] (Wave 2) Add `setIdcAssignments` operation schema + inferred type.
- [x] Keep unsupported diff schema list aligned to remaining unsupported kinds only.
- [ ] Add/extend operation schema tests for all variants.

### Phase 6.2: Diff engine (Wave 1) (`src/diff.ts`)

- [x] Emit `createOu` operation for resolvable new OU instead of `newOu` unsupported.
- [x] Emit `renameOu` operation for supported rename cases instead of `renamedOu` unsupported.
- [x] Emit `createAccount` operation instead of `newAccount` unsupported.
- [x] Preserve `removedOu` as destructive unsupported.
- [x] Preserve `removedAccount` as destructive unsupported.
- [x] Keep deterministic operation sorting with expanded operation kinds.
- [x] Update diff tests for new operation output and stable ordering.

### Phase 6.3: Apply executor (Wave 1) (`src/commands/apply.ts`)

- [x] Add `createOu` execution via Organizations API.
- [x] Add `renameOu` execution via Organizations API.
- [x] Add `createAccount` execution path (shared helper approach).
- [ ] Update in-memory state mutation logic for each new operation.
- [ ] Ensure partial-failure persistence works with mixed old/new operations.
- [ ] Keep unsupported/destructive gates unchanged for remaining unsupported diffs.
- [ ] Add apply tests for each Wave 1 operation kind.

### Phase 6.4: Shared account create flow extraction

- [x] Extract reusable account-create orchestration helper from `create-account` command.
- [x] Reuse helper from `create-account` CLI command without behavior regression.
- [x] Reuse helper from apply `createAccount` operation.
- [ ] Preserve logging clarity in both command and apply contexts.
- [ ] Add regression tests for `create-account` command behavior.

### Phase 6.5: Plan command output updates (`src/commands/plan.ts`)

- [ ] Add human-readable plan lines for `createOu`.
- [ ] Add human-readable plan lines for `renameOu`.
- [ ] Add human-readable plan lines for `createAccount`.
- [ ] Keep `--json` output schema compatibility and deterministic ordering.
- [ ] Update plan tests for new operation rendering.

### Phase 6.6: CLI wiring and client inputs

- [ ] Ensure apply input includes all clients required by supported operations.
- [ ] Keep `--ignore-unsupported` behavior unchanged.
- [ ] Keep confirmation prompt behavior unchanged.
- [ ] Verify replay command output remains correct for plan/apply.

### Phase 6.7: Docs and policy (Wave 1)

- [x] Update `docs/phase-6-plan.md` checkboxes as implementation lands.
- [ ] Update `docs/phase-5-plan.md` with superseding Phase 6 status note.
- [ ] Update `plan.md` with new phase/checkboxes for expanded apply scope.
- [ ] Update README supported actions for `plan/apply`.
- [ ] Update README IAM permissions for any newly required Organizations APIs.

### Phase 6.8: Wave 2 (IdC) readiness decision gate

- [ ] Decide go/no-go for Wave 2 immediately after Wave 1 stabilization.
- [ ] If go: lock exact IdC mutation scope for first IdC increment.
- [ ] If go: add operation schemas and diff emission for IdC additions/assignment changes.
- [ ] If go: implement apply execution + state mutation for IdC operations.
- [ ] If go: add full IdC test matrix (diff, plan, apply, partial failure).

### Phase 6.9: Validation and release checklist

- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`.
- [ ] Verify no unintended file rewrites in working tree.
- [ ] Execute manual smoke tests for Wave 1 supported operations.
- [ ] Update this checklist to fully reflect final shipped behavior.
