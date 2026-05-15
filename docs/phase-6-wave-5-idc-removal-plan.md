# Phase 6 Wave 5: IAM Identity Center Entity Removal Plan

This document captures the proposed next v1 feature after the shipped Wave 4
permission set policy work.

Cloud-backed execution (`Lambda` / `S3` / saved remote plans) remains **v2**.
This wave stays in the current local-first v1 model:

- `plan` remains local-only
- `apply` executes directly through AWS SDK clients in the CLI
- `state.json` remains the persisted source of actual state
- partial-failure persistence remains in place

> **Note:** The local execution model described above was subsequently removed in favor of remote-only execution. See [docs/adr/001-remove-local-execution-model.md](adr/001-remove-local-execution-model.md).

## Goal

Support config-driven destructive lifecycle for IAM Identity Center entities:

- delete users removed from `aws.config.ts`
- delete groups removed from `aws.config.ts`
- delete permission sets removed from `aws.config.ts`

while preserving:

- schema-first operation modeling
- deterministic plan/apply output
- sequential apply execution
- partial-failure persistence to `state.json`
- explicit destructive gating with `apply --allow-destructive`

## Why this should be next

Repository head now supports:

- additive user/group/permission set creation
- group membership reconciliation
- account assignment reconciliation
- permission set policy reconciliation

The biggest remaining v1 IAM Identity Center gap is full entity lifecycle.
Today, deleting a user, group, or permission set from config still blocks
`apply`, even though the tool already knows how to:

- identify prerequisite memberships and assignments
- remove group memberships
- revoke account assignments
- preserve successful intermediate state on failure

That makes destructive IdC lifecycle the highest-value remaining v1 feature.

## Scope

In scope for this wave:

- deleting users
- deleting groups
- deleting permission sets
- automatically emitting prerequisite membership removals and assignment revokes
  needed to make those deletions succeed
- destructive gating through the existing `apply --allow-destructive` flow

Out of scope for this wave:

- editing IdC metadata after creation
- account removals
- account metadata reconciliation after creation
- permissions-boundary reconciliation
- application-assignment / portal settings
- any cloud-backed remote execution model

## Safety boundary

This wave should be intentionally narrow and explicit.

Destructive IdC entity removal should require all of the following:

- the entity is removed from authored config
- the current state contains enough relationship data to derive prerequisite
  cleanup deterministically
- `plan` shows the prerequisite cleanup and the final delete explicitly
- `apply` requires `--allow-destructive`

Recommended rules:

1. Removing a user should emit:
   - `removeIdcGroupMembership` for memberships referencing that user
   - `revokeIdcAccountAssignment` for direct user assignments
   - `deleteIdcUser`
2. Removing a group should emit:
   - `removeIdcGroupMembership` for memberships referencing that group
   - `revokeIdcAccountAssignment` for direct group assignments
   - `deleteIdcGroup`
3. Removing a permission set should emit:
   - `revokeIdcAccountAssignment` for all assignments referencing that permission
     set
   - `deleteIdcPermissionSet`

Important non-goals:

- no hidden deletion side effects
- no soft-delete / trash model
- no skipping prerequisite cleanup
- no destructive override for unsupported destructive diffs outside the modeled
  boundary

## Config and state model

No authored config schema change is required for this wave.

Removal continues to be expressed by omission from `aws.config.ts`.

No new persisted state schema fields are required either because repository head
already scans and persists:

- users
- groups
- group memberships
- permission sets
- account assignments

That existing state is enough to derive the destructive prerequisites
deterministically.

## Operation model

Add these destructive entity operations in [`src/operations.ts`](../src/operations.ts):

- `deleteIdcUser`
- `deleteIdcGroup`
- `deleteIdcPermissionSet`

Recommended payloads:

```ts
{
  kind: "deleteIdcUser";
  userName: string;
}

{
  kind: "deleteIdcGroup";
  groupDisplayName: string;
}

{
  kind: "deleteIdcPermissionSet";
  permissionSetName: string;
}
```

Keep existing prerequisite operations:

- `removeIdcGroupMembership`
- `revokeIdcAccountAssignment`

This is important because the plan should continue to expose the exact AWS-side
cleanup that will happen before the terminal delete.

## Unsupported-diff cleanup

Wave 2 introduced unsupported destructive diff kinds:

- `idcUserRemoved`
- `idcGroupRemoved`
- `idcPermissionSetRemoved`

After this wave, those should stop being emitted for supported removals.

Recommended cleanup:

- remove those kinds from the primary unsupported path
- keep unsupported destructive handling only for cases that still fall outside
  the explicit modeled boundary

## Diff strategy

Extend [`src/diff.ts`](../src/diff.ts) so destructive IdC removals emit real
operations rather than unsupported diffs.

### Removed users

For each current user absent from next config:

1. emit `removeIdcGroupMembership` for every current membership referencing that
   user
2. emit `revokeIdcAccountAssignment` for every current direct user assignment
3. emit `deleteIdcUser`

### Removed groups

For each current group absent from next config:

1. emit `removeIdcGroupMembership` for every current membership referencing that
   group
2. emit `revokeIdcAccountAssignment` for every current direct group assignment
3. emit `deleteIdcGroup`

### Removed permission sets

For each current permission set absent from next config:

1. emit `revokeIdcAccountAssignment` for every current assignment referencing
   that permission set
2. emit `deleteIdcPermissionSet`

### Suppression rules

Current diff logic suppresses derivative removals when the parent entity removal
is unsupported. That suppression should be replaced with explicit prerequisite
emission for supported removals.

Recommended behavior:

- if a membership disappears only because its user/group is being deleted, emit
  the membership removal explicitly
- if an assignment disappears only because its user/group/permission set is
  being deleted, emit the revoke explicitly
- avoid duplicates when the same prerequisite is already removed directly in the
  desired state

## Permission set deletion note

Repository head now reconciles inline policies and policy attachments for
permission sets.

For this wave, `deleteIdcPermissionSet` should not emit separate policy detach
operations first. The plan should treat permission set deletion as:

- revoke all account assignments first
- delete the permission set

This keeps destructive permission set lifecycle readable and avoids noisy,
redundant detach operations in the plan.

## Execution ordering

Extend the internal execution priority in [`src/diff.ts`](../src/diff.ts).

Recommended order, continuing from the shipped Wave 4 ordering:

1. `createOu`
2. `renameOu`
3. `createAccount`
4. `moveAccount`
5. `createIdcUser`
6. `createIdcGroup`
7. `addIdcGroupMembership`
8. `createIdcPermissionSet`
9. `putIdcPermissionSetInlinePolicy`
10. `deleteIdcPermissionSetInlinePolicy`
11. `attachIdcManagedPolicyToPermissionSet`
12. `detachIdcManagedPolicyFromPermissionSet`
13. `attachIdcCustomerManagedPolicyReferenceToPermissionSet`
14. `detachIdcCustomerManagedPolicyReferenceFromPermissionSet`
15. `provisionIdcPermissionSet`
16. `grantIdcAccountAssignment`
17. `removeIdcGroupMembership`
18. `revokeIdcAccountAssignment`
19. `deleteIdcUser`
20. `deleteIdcGroup`
21. `deleteIdcPermissionSet`
22. `deleteOu`

Why this order:

- additive operations still run first
- destructive membership / assignment cleanup happens before terminal entity
  deletion
- permission sets are deleted only after all assignment revokes complete
- OU deletion remains the latest destructive operation

## Apply changes

Extend [`src/commands/apply.ts`](../src/commands/apply.ts):

- resolve `userName` -> `userId`
- resolve `groupDisplayName` -> `groupId`
- resolve `permissionSetName` -> `permissionSetArn`
- call the correct destructive AWS SDK commands
- update working state after each successful delete

Expected AWS SDK commands:

- `DeleteUserCommand`
- `DeleteGroupCommand`
- `DeletePermissionSetCommand`

Existing prerequisite commands already available:

- `DeleteGroupMembershipCommand`
- `DeleteAccountAssignmentCommand`
- `DescribeAccountAssignmentDeletionStatusCommand`

Recommended behavior:

- user deletion removes the user from working state
- group deletion removes the group from working state
- permission set deletion removes the permission set from working state
- existing membership / assignment helpers continue to keep derived indexes and
  access roles correct

## Human-readable output

Extend:

- [`src/commands/plan.ts`](../src/commands/plan.ts)
- [`src/commands/apply.ts`](../src/commands/apply.ts)

Expected example lines:

- `[destructive] delete IdC user "alice"`
- `[destructive] delete IdC group "Admins"`
- `[destructive] delete IdC permission set "AdminAccess"`

Recommended preview shape for a removed group with assignments:

```text
Apply: 3 operation(s), 0 unsupported diff(s)
WARNING: this apply includes destructive operations. Review carefully before confirming.
  remove user "alice" from IdC group "Admins"
  revoke IdC assignment "AdminAccess" from group "Admins" on "AppAccount"
  [destructive] delete IdC group "Admins"
```

## Tests

Add focused coverage in:

- [`src/operations.test.ts`](../src/operations.test.ts)
- [`src/diff.test.ts`](../src/diff.test.ts)
- [`src/commands/plan.test.ts`](../src/commands/plan.test.ts)
- [`src/commands/apply.test.ts`](../src/commands/apply.test.ts)
- optionally [`src/state.test.ts`](../src/state.test.ts) if new remove helpers are
  added

Recommended scenarios:

1. removing a user emits prerequisite membership removals, assignment revokes,
   and trailing `deleteIdcUser`
2. removing a group emits prerequisite membership removals, assignment revokes,
   and trailing `deleteIdcGroup`
3. removing a permission set emits prerequisite assignment revokes and trailing
   `deleteIdcPermissionSet`
4. direct desired membership removal is not duplicated by derivative deletion
5. direct desired assignment revoke is not duplicated by derivative deletion
6. apply refuses destructive IdC deletes without `--allow-destructive`
7. apply issues the correct delete commands and updates persisted state
8. partial failure persists successfully removed prerequisites before a later
   entity-delete failure

## Docs and permissions

Update after implementation:

- [`README.md`](../README.md)
- [`docs/v1-backlog-priority.md`](./v1-backlog-priority.md)
- this plan doc with an implemented-status note

Expected IAM permissions:

- apply:
  - `identitystore:DeleteUser`
  - `identitystore:DeleteGroup`
  - `sso:DeletePermissionSet`

No scan/init permission expansion should be necessary for this wave because the
required relationship data is already part of repository-head scan output.

## Suggested implementation order

1. Add destructive IdC delete operation schemas.
2. Replace unsupported removal emission with prerequisite-aware diff emission.
3. Add working-state remove helpers for users, groups, and permission sets.
4. Implement apply-time destructive execution and state updates.
5. Update plan/apply output and destructive warnings.
6. Add focused diff/apply coverage for each entity kind.
