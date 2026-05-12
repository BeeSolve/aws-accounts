# Phase 6 Wave 3: IAM Identity Center Group Membership Management Plan

This document captures the implemented Wave 3 follow-up after Wave 2 IdC
additive reconciliation.

Status: implemented in repository head. This document now serves as the design
record for the shipped group-membership wave.

Cloud-backed execution (`Lambda` / `S3` / saved remote plans) is treated as **v2**. This wave stays in the current local-first v1 model:

- `plan` remains local-only
- `apply` executes directly through AWS SDK clients in the CLI
- `state.json` remains the persisted source of actual state
- partial-failure persistence remains in place

## Goal

Support config-driven IAM Identity Center **group membership management** for v1:

- scan existing group memberships into `state.json`
- generate memberships into `aws.config.ts`
- diff desired vs current memberships
- add missing memberships during `apply`
- remove stale memberships during `apply`

while preserving:

- schema-first operation modeling
- deterministic plan/apply output
- sequential apply execution
- partial-failure persistence to `state.json`
- existing unsupported-entity safety rules for user/group removal

## Scope

This wave should implement **user-to-group memberships only**.

In scope:

- user membership in IdC groups
- create membership when config adds a user to a group
- remove membership when config removes a user from a group
- same-batch dependency resolution when the user and/or group is also created in the same apply run

Out of scope for this wave:

- removing users
- removing groups
- editing group metadata after creation
- nested groups / non-user member principals
- permission set policy / attachment management
- permission set metadata updates
- account removals
- account metadata reconciliation after creation

## Proposed config model

Extend `groups` in [`src/awsConfig.ts`](../src/awsConfig.ts) from:

```ts
groups: Array<{
  displayName: string;
}>
```

to:

```ts
groups: Array<{
  displayName: string;
  members: string[];
}>
```

Where:

- each `members` entry is a `userName`
- generated types should constrain `members` to the known user-name picklist
- `members` should be deterministically sorted

Why this shape:

- memberships stay colocated with the group they belong to
- the authored config remains easy to read
- it avoids introducing a second top-level relationship collection when `groups` already exists

## Proposed persisted state model

Extend `identityCenter` in [`src/state.ts`](../src/state.ts) with:

```ts
groupMemberships: Array<{
  membershipId: string;
  groupId: string;
  userId: string;
}>
```

Why persist memberships separately in `state.json`:

- scan can capture the real AWS membership identity once
- apply can remove memberships without re-deriving everything from config
- partial-failure persistence remains explicit and auditable

## Working-state additions

Extend `WorkingIdentityCenterState` in [`src/state.ts`](../src/state.ts) with:

- `groupMemberships`
- `groupMembershipsByKey`

Recommended natural key:

- `${groupId}|${userId}`

Add immutable helpers in [`src/state.ts`](../src/state.ts) for:

- adding/upserting a group membership
- removing a group membership

As with current IdC helpers:

1. arrays and indexes must be updated together
2. `materializeWorkingState()` must round-trip the persisted shape
3. normalization must keep output deterministic

## Scan changes

Extend [`src/commands/scan.ts`](../src/commands/scan.ts) to collect group memberships.

Recommended AWS API path:

- use `ListGroupMemberships` for each scanned group
- capture `MembershipId`
- resolve member user ids from the response

Expected AWS SDK commands:

- `ListGroupMembershipsCommand`

Additional scan behavior:

- skip incomplete rows that do not contain the required ids
- fail fast if AWS returns a membership shape that cannot be represented by the v1 user-only model

## State -> config transform changes

Extend `mapStateToAwsConfig()` in [`src/awsConfig.ts`](../src/awsConfig.ts):

- resolve each `groupMemberships` row to `(group.displayName, user.userName)`
- emit sorted `members` arrays on each group

If a membership references a missing user or group in scanned state, fail fast with an actionable error rather than silently dropping it.

## Config -> state transform changes

Extend `mapAwsConfigToState()` in [`src/awsConfig.ts`](../src/awsConfig.ts):

- flatten `groups[].members` into `groupMemberships`
- reuse existing `membershipId` when the same `(group, user)` relationship already exists in current state
- emit the shared `pendingCreationId` for memberships that exist only in config

Important: diffing should **not** use sentinel membership ids as the logical identity. Membership reconciliation should follow the same name-based normalization pattern used for Wave 2 IdC assignments.

## Operation model

Add two new operations in [`src/operations.ts`](../src/operations.ts):

- `addIdcGroupMembership`
- `removeIdcGroupMembership`

Recommended user-facing payload:

```ts
{
  kind: "addIdcGroupMembership" | "removeIdcGroupMembership";
  groupDisplayName: string;
  userName: string;
}
```

Keep the public operation schema name-based. Concrete AWS ids should be resolved at apply-time from the current working state.

## Diff strategy

Extend [`src/diff.ts`](../src/diff.ts) with a normalized group-membership view:

- current memberships keyed by `(groupDisplayName, userName)`
- desired memberships keyed by `(groupDisplayName, userName)`

Emit:

- desired missing in current -> `addIdcGroupMembership`
- current missing in desired -> `removeIdcGroupMembership`

### Suppression rule for unsupported entity removals

This wave should mirror the existing assignment suppression rule.

If a user or group is removed from config:

- the root user/group removal remains unsupported
- derivative `removeIdcGroupMembership` operations caused **only** by that unsupported removal should be suppressed

Reason:

- otherwise the tool would partially implement unsupported user/group deletion by stripping memberships while still refusing the real mutation
- plan output would become noisy and misleading

## Execution ordering

Extend the internal execution priority in [`src/diff.ts`](../src/diff.ts).

Recommended order:

1. `createOu`
2. `renameOu`
3. `createAccount`
4. `moveAccount`
5. `createIdcUser`
6. `createIdcGroup`
7. `addIdcGroupMembership`
8. `createIdcPermissionSet`
9. `grantIdcAccountAssignment`
10. `removeIdcGroupMembership`
11. `revokeIdcAccountAssignment`
12. `deleteOu`

Notes:

- add-membership must run after user/group creation in mixed batches
- remove-membership does not need destructive gating; it is closer to assignment revoke than entity deletion
- apply should keep executing the already-sorted plan as-is

## Apply changes

Extend [`src/commands/apply.ts`](../src/commands/apply.ts):

- resolve `groupDisplayName` -> `groupId` from working state
- resolve `userName` -> `userId` from working state
- create membership with `CreateGroupMembershipCommand`
- delete membership with `DeleteGroupMembershipCommand`

Recommended delete strategy:

1. use persisted `membershipId` from working state when available
2. if needed, resolve it via `GetGroupMembershipIdCommand`

Expected AWS SDK commands:

- `CreateGroupMembershipCommand`
- `DeleteGroupMembershipCommand`
- `GetGroupMembershipIdCommand`

Apply-time failure handling should stay unchanged:

- first failure aborts the remaining batch
- successful earlier operations persist to `state.json`
- user is instructed to run `scan`, verify, and re-run `apply`

## Plan/apply output

Extend human-readable output in:

- [`src/commands/plan.ts`](../src/commands/plan.ts)
- [`src/commands/apply.ts`](../src/commands/apply.ts)

Expected messages:

- `add IdC group membership user "alice" -> group "Admins"`
- `remove IdC group membership user "alice" -> group "Admins"`

Machine-readable `plan --json` should include these operations automatically through the shared operation schema.

## Tests

Add focused coverage in:

- [`src/state.test.ts`](../src/state.test.ts)
- [`src/awsConfig.test.ts`](../src/awsConfig.test.ts)
- [`src/diff.test.ts`](../src/diff.test.ts)
- [`src/commands/scan.test.ts`](../src/commands/scan.test.ts)
- [`src/commands/plan.test.ts`](../src/commands/plan.test.ts)
- [`src/commands/apply.test.ts`](../src/commands/apply.test.ts)
- [`src/operations.test.ts`](../src/operations.test.ts)

Recommended scenarios:

1. scan captures memberships into `state.json`
2. state -> config emits sorted `groups[].members`
3. config -> state reuses existing membership ids
4. diff emits `addIdcGroupMembership`
5. diff emits `removeIdcGroupMembership`
6. diff suppresses derivative membership removals for unsupported user removal
7. diff suppresses derivative membership removals for unsupported group removal
8. apply creates membership and persists updated state
9. apply removes membership and persists updated state
10. mixed batch: create user + create group + add membership
11. plan/apply human output prints membership operations deterministically

## Docs and permissions

Update after implementation:

- [`README.md`](../README.md)
- [`docs/phase-6-wave-2-idc-plan.md`](./phase-6-wave-2-idc-plan.md) or a follow-up status note
- [`docs/phase-6-wave-4-permission-set-policy-plan.md`](./phase-6-wave-4-permission-set-policy-plan.md) as the next planned follow-up

IAM permissions for `apply` / `scan` will need Identity Store membership APIs added, expected at minimum:

- `identitystore:ListGroupMemberships`
- `identitystore:CreateGroupMembership`
- `identitystore:DeleteGroupMembership`
- `identitystore:GetGroupMembershipId`

## Why this should be next

This is the highest-value remaining v1 IdC feature because it completes the currently incomplete group story:

- groups can already be scanned
- groups can already be authored
- groups can already be created
- group-based account assignments already work
- but group membership is still the missing link that makes groups useful for real access management

Compared with the other remaining v1 items, this wave is:

- narrower than IdC entity deletion
- safer than account removal
- more immediately valuable than watcher/sync ergonomics
- a cleaner dependency for later permission-set policy work

## Remaining v1 backlog after this wave

If this wave ships, the major remaining v1 feature gaps would be:

1. permission set policy / attachment management
2. IdC user/group/permission-set removal
3. IdC metadata updates after creation
4. account removals
5. account metadata reconciliation after creation
6. optional machine-readable destructive metadata in `plan --json`
