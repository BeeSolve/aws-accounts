# ADR 005: Same-Plan OU Dependency Resolution

## Status

Accepted

## Date

2026-05-19

## Context

When a user creates a new OU and simultaneously wants to create an account inside it (or move an existing account into it), the planner marked the account operations as `unsupportedMutation` because the new OU's real AWS ID doesn't exist yet (`__pending_creation__`). Users had to run two separate plan/apply cycles — one to create the OU, another to populate it.

Example output that prompted this:

```
Plan: 1 operation(s), 1 unsupported diff(s)
  create OU "integration" under projects
Unsupported diffs:
  - new account "KitOnLambdaTest" has unresolved target OU "integration" (__pending_creation__) [unsupportedMutation]
```

The apply phase already executes operations sequentially and updates working state with real AWS IDs after each operation completes — so the infrastructure to resolve this at apply time already existed. The existing `resolvePolicyId` pattern in `applyLogic.ts` demonstrates this exact approach for org policies created and attached in the same plan.

The state representation uses `__pending_creation__` as a sentinel ID for all entities not yet created in AWS. Multiple new OUs in the same plan share this sentinel, which makes the parent name non-derivable from the ID alone for nested new OUs. This is a known limitation of the current state schema.

## Decision

Resolve same-plan OU dependencies at apply time rather than requiring a second plan/apply cycle.

### 1. "OUs being created in this plan" set in `diffStates()`

Before the account processing loop, compute the set of OU names that will have a `createOu` operation in this plan:

```ts
const ouNamesBeingCreated = new Set(
  nextOrganization.organizationalUnits
    .filter(ou => !currentOrganization.organizationalUnitByName.has(ou.name))
    .map(ou => ou.name),
);
```

### 2. Loosen `unsupportedMutation` guards

For `createAccount`, `moveAccount`, and `createOu` operations where the target/parent OU ID is `__pending_creation__`:

- If the resolved OU name is in `ouNamesBeingCreated` (and is not self-referential — i.e. the OU name differs from the OU being created), emit the operation with `targetOuId`/`toOuId`/`parentOuId` set to the pending sentinel and the name field set for later resolution.
- Otherwise keep emitting `unsupportedMutation` as before.

A new `existingAccountWithUnknownTargetOu` unsupported-diff kind is added for the previously-silent case of an existing account being moved to a truly unknown OU.

### 3. Topological sort of `createOu` operations

After the main priority sort, perform a DFS topological sort on the `createOu` subset so that parent OUs are always created before their children. This only activates when at least one `createOu` operation carries a pending parent ID.

### 4. Apply-time ID resolution

Add `resolveOrganizationalUnitId` in `applyLogic.ts` (mirroring the existing `resolvePolicyId`):

```ts
function resolveOrganizationalUnitId(props: {
  state: WorkingState;
  organizationalUnitId: string;
  organizationalUnitName: string;
}): string {
  if (props.organizationalUnitId !== "__pending_creation__") return props.organizationalUnitId;
  const ou = Object.values(props.state.organization.organizationalUnitsById)
    .find(ou => ou.name === props.organizationalUnitName);
  if (ou == null) throw new Error(`Could not resolve OU "${props.organizationalUnitName}" in working state.`);
  return ou.id;
}
```

This is called in the `createOu`, `createAccount`, and `moveAccount` handlers before each AWS API call. Because operations execute sequentially and `upsertOrganizationalUnitInWorkingState` stores the real AWS ID after each `createOu`, the resolver finds the real ID in working state by the time dependent operations run.

## Rationale

- **Why resolve at apply time rather than plan time?** Plan time has no AWS IDs for new OUs — they don't exist yet. The sequential apply loop with mutable working state is the only place where real IDs become available. This is already how policy-then-attachment works.
- **Why encode OU names in operations rather than IDs?** Names are stable and meaningful. The real AWS ID is unknown until `createOu` executes; the name is what connects the planner's intent to the apply-time lookup.
- **Why not change the state schema to carry `parentName`?** It would be more correct for deeply nested same-plan OU creation, but adds schema complexity and migration burden. The current approach handles the common cases (new OU + new/moved account) without a schema change. Deeply nested new OUs are an edge case that can be addressed separately.
- **Why keep `unsupportedMutation` for truly unknown OUs?** Safety. If the resolved parent name is not in any planned `createOu`, the operation cannot be ordered correctly and the error should be surfaced before any AWS calls are made.

## Consequences

- Creating a new OU and placing accounts in it (new or moved) is now a single plan/apply cycle.
- Nested new OU creation (parent + child both new in one plan) works when the state array ordering causes the parent's name to win in the `organizationalUnitNameById` map. This is order-dependent and may not work reliably for multiple levels of nesting — a known limitation.
- A new `existingAccountWithUnknownTargetOu` unsupported-diff kind replaces the previous silent skip when an existing account targets a truly unknown pending OU.
- No state schema changes — backwards compatible.
